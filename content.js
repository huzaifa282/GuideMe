// Wrapped so it can be injected again (via chrome.scripting) without redeclaration errors.
// A newer version replaces an older copy already running in the page. Message types carry
// the version, so a stale copy that is still alive never answers a newer panel.
(() => {
const VERSION = 5;
if (window.__guidemeVersion === VERSION) return;
if (window.__guidemeCleanup) window.__guidemeCleanup();
window.__guidemeVersion = VERSION;

const MAX_ELEMENTS = 60;
const MAX_TEXT = 40;
const SELECTOR = 'button, a, input, select, [role=button]';

let overlayHost = null;
let pillHost = null;
let rafId = null;

// Small animated status pill at the top of the page (Shadow DOM, so site CSS can't touch it).
function showStatus(text) {
  hideStatus();
  pillHost = document.createElement('div');
  pillHost.id = 'guideme-status';
  pillHost.style.cssText = 'position:fixed;top:12px;left:0;right:0;display:flex;justify-content:center;pointer-events:none;z-index:2147483647;';
  const shadow = pillHost.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .pill {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        border-radius: 999px;
        background: #1f1f1f;
        color: #fff;
        font: 14px/1.2 system-ui, sans-serif;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
        animation: fade-in 0.2s ease-out;
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #ff6a00;
        animation: blink 1s ease-in-out infinite;
      }
      @keyframes blink { 0%, 100% { opacity: 0.25; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.1); } }
      @keyframes fade-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
    </style>
    <div class="pill"><span class="dot"></span><span class="label"></span></div>`;
  shadow.querySelector('.label').textContent = text;
  document.documentElement.appendChild(pillHost);
}

function hideStatus() {
  if (pillHost) pillHost.remove();
  pillHost = null;
}

// Visible to the user: styled visible, non-zero size, centre inside the viewport,
// and not covered by another element (this also excludes elements behind a modal).
function isVisible(el) {
  if (el.matches('input[type=hidden]')) return false;
  if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
  const top = document.elementFromPoint(cx, cy);
  return !!top && (top === el || el.contains(top) || top.contains(el));
}

function scanElements() {
  document.querySelectorAll('[data-guideme-id]').forEach((el) => el.removeAttribute('data-guideme-id'));

  const found = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (found.length >= MAX_ELEMENTS) break;
    if (!isVisible(el)) continue;

    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    const ariaLabel = el.getAttribute('aria-label') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    if (!text && !ariaLabel && !placeholder) continue;

    const key = `${tag}|${text.toLowerCase()}|${text ? '' : ariaLabel + '|' + placeholder}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const id = String(found.length + 1);
    el.setAttribute('data-guideme-id', id);
    found.push({ id, tag, text, ariaLabel, placeholder });
  }
  return found;
}

function clearHighlight() {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  document.removeEventListener('keydown', onKeydown, true);
  if (overlayHost) overlayHost.remove();
  overlayHost = null;
}

function onKeydown(e) {
  if (e.key === 'Escape') clearHighlight();
}

// Corner radius of the element in px (percentages resolve against the smaller side).
function cornerRadius(el, rect) {
  const value = getComputedStyle(el).borderTopLeftRadius;
  const n = parseFloat(value) || 0;
  return value.endsWith('%') ? (n / 100) * Math.min(rect.width, rect.height) : n;
}

const OVERLAY_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .ring {
    position: fixed;
    border: 3px solid #10b981;
    pointer-events: none;
    /* Light spotlight: dims everything outside the ring. */
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.35);
    transition: box-shadow 0.25s ease;
  }
  .ring.hover { box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0); }
  .ring::after {
    content: '';
    position: absolute;
    inset: -3px;
    border-radius: inherit;
    pointer-events: none;
    animation: glow 1.6s ease-out infinite;
  }
  @keyframes glow {
    0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.55); }
    100% { box-shadow: 0 0 0 14px rgba(16, 185, 129, 0); }
  }
  .badge {
    position: fixed;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #10b981;
    color: #fff;
    font: 700 13px/24px system-ui, sans-serif;
    text-align: center;
    pointer-events: none;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  }
  .card {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    width: calc(100vw - 32px);
    max-width: 420px;
    padding: 14px 40px 12px 16px;
    border-radius: 14px;
    background: #fff;
    color: #111827;
    font-family: system-ui, sans-serif;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25), 0 1px 3px rgba(0, 0, 0, 0.12);
    pointer-events: auto;
    animation: slide-up 0.2s ease-out;
  }
  .card.top { bottom: auto; top: 24px; animation-name: slide-down; }
  .card[dir=rtl] { padding: 14px 16px 12px 40px; }
  @keyframes slide-up {
    from { opacity: 0; transform: translate(-50%, 12px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }
  @keyframes slide-down {
    from { opacity: 0; transform: translate(-50%, -12px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }
  .step { font-size: 12px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; color: #10b981; }
  .text { margin-top: 4px; font-size: 15px; line-height: 1.4; }
  .notice { margin-top: 8px; font-size: 13px; color: #b45309; }
  .footer { margin-top: 10px; font-size: 11px; color: #6b7280; }
  .close {
    position: absolute;
    top: 8px;
    inset-inline-end: 8px;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: #6b7280;
    font: 18px/26px system-ui, sans-serif;
    cursor: pointer;
  }
  .close:hover { background: #f3f4f6; color: #111827; }
  [hidden] { display: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .ring, .card { transition: none; animation: none; }
    .ring::after { animation: none; }
  }
`;

function highlight(id, instruction, step) {
  clearHighlight();
  hideStatus();
  const el = document.querySelector(`[data-guideme-id="${id}"]`);
  if (!el) return false;

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  overlayHost = document.createElement('div');
  overlayHost.id = 'guideme-overlay';
  overlayHost.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const shadow = overlayHost.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${OVERLAY_CSS}</style>
    <div class="ring"></div>
    <div class="badge"></div>
    <div class="card" role="status">
      <div class="step"></div>
      <div class="text"></div>
      <div class="notice" hidden>Scroll to see the highlighted item</div>
      <div class="footer">GuideMe</div>
      <button class="close" type="button" aria-label="Close">×</button>
    </div>`;
  const ring = shadow.querySelector('.ring');
  const badge = shadow.querySelector('.badge');
  const card = shadow.querySelector('.card');
  const notice = shadow.querySelector('.notice');
  const stepNumber = step || 1;
  badge.textContent = stepNumber;
  shadow.querySelector('.step').textContent = `Step ${stepNumber}`;
  shadow.querySelector('.text').textContent = instruction;
  // Right-to-left scripts (Urdu, Arabic, Hebrew) flip the card.
  card.dir = /[֐-ࣿ]/.test(instruction) ? 'rtl' : 'ltr';
  shadow.querySelector('.close').addEventListener('click', clearHighlight);
  document.documentElement.appendChild(overlayHost);
  document.addEventListener('keydown', onKeydown, true);

  // Fade the dim out while the user hovers or focuses the target, so menus stay readable.
  const setHover = (on) => ring.classList.toggle('hover', on);
  el.addEventListener('mouseenter', () => setHover(true));
  el.addEventListener('mouseleave', () => setHover(false));
  el.addEventListener('focus', () => setHover(true));
  el.addEventListener('blur', () => setHover(false));

  const PAD = 6;
  const BADGE = 24;
  const BADGE_GAP = 4;
  const DOCK_ZONE = 160;
  function track() {
    const r = el.getBoundingClientRect();
    const inView = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;

    ring.hidden = badge.hidden = !inView;
    notice.hidden = inView;
    if (inView) {
      ring.style.left = `${r.left - PAD}px`;
      ring.style.top = `${r.top - PAD}px`;
      ring.style.width = `${r.width + PAD * 2}px`;
      ring.style.height = `${r.height + PAD * 2}px`;
      ring.style.borderRadius = `${cornerRadius(el, r) + 4}px`;
      // Above the ring's top-left corner, outside it, so it never covers dropdowns opening below.
      badge.style.left = `${Math.max(4, r.left - PAD)}px`;
      badge.style.top = `${Math.max(4, r.top - PAD - BADGE - BADGE_GAP)}px`;
    }
    // Dock the card at the top when the target sits in the bottom zone of the viewport.
    card.classList.toggle('top', inView && r.bottom > window.innerHeight - DOCK_ZONE);

    rafId = requestAnimationFrame(track);
  }
  track();
  return true;
}

function onMessage(message, sender, sendResponse) {
  if (message.type === `guideme${VERSION}:scan`) {
    sendResponse({ elements: scanElements(), title: document.title, url: location.href, version: VERSION });
  } else if (message.type === `guideme${VERSION}:highlight`) {
    sendResponse({ ok: highlight(message.id, message.instruction, message.step) });
  } else if (message.type === `guideme${VERSION}:clear`) {
    clearHighlight();
    hideStatus();
    sendResponse({ ok: true });
  } else if (message.type === `guideme${VERSION}:status`) {
    showStatus(message.text);
    sendResponse({ ok: true });
  } else if (message.type === `guideme${VERSION}:hide-status`) {
    hideStatus();
    sendResponse({ ok: true });
  }
}
chrome.runtime.onMessage.addListener(onMessage);

window.__guidemeCleanup = () => {
  clearHighlight();
  hideStatus();
  chrome.runtime.onMessage.removeListener(onMessage);
};

console.log(`[GuideMe] content script v${VERSION} loaded`);
})();
