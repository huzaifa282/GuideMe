// Wrapped so it can be injected again (via chrome.scripting) without redeclaration errors.
// A newer version replaces an older copy already running in the page. Message types carry
// the version, so a stale copy that is still alive never answers a newer panel.
(() => {
const VERSION = 3;
if (window.__guidemeVersion === VERSION) return;
if (window.__guidemeCleanup) window.__guidemeCleanup();
window.__guidemeVersion = VERSION;

const MAX_ELEMENTS = 60;
const MAX_TEXT = 40;
const SELECTOR = 'button, a, input, select, [role=button]';

let overlayHost = null;
let rafId = null;

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
  if (overlayHost) overlayHost.remove();
  overlayHost = null;
}

function highlight(id, instruction) {
  clearHighlight();
  const el = document.querySelector(`[data-guideme-id="${id}"]`);
  if (!el) return false;

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  overlayHost = document.createElement('div');
  overlayHost.id = 'guideme-overlay';
  overlayHost.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const shadow = overlayHost.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .ring {
        position: fixed;
        box-sizing: border-box;
        border: 3px solid #ff6a00;
        border-radius: 8px;
        animation: pulse 1.2s ease-out infinite;
      }
      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(255, 106, 0, 0.6); }
        100% { box-shadow: 0 0 0 14px rgba(255, 106, 0, 0); }
      }
      .bubble {
        position: fixed;
        max-width: 260px;
        padding: 8px 12px;
        border-radius: 8px;
        background: #1f1f1f;
        color: #fff;
        font: 14px/1.3 system-ui, sans-serif;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
      }
    </style>
    <div class="ring"></div>
    <div class="bubble"></div>`;
  const ring = shadow.querySelector('.ring');
  const bubble = shadow.querySelector('.bubble');
  bubble.textContent = instruction;
  document.documentElement.appendChild(overlayHost);

  const PAD = 4;
  const GAP = 10;
  function track() {
    const r = el.getBoundingClientRect();
    ring.style.left = `${r.left - PAD}px`;
    ring.style.top = `${r.top - PAD}px`;
    ring.style.width = `${r.width + PAD * 2}px`;
    ring.style.height = `${r.height + PAD * 2}px`;

    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const below = r.bottom + PAD + GAP;
    const top = below + bh <= window.innerHeight ? below : r.top - PAD - GAP - bh;
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - bw - 8));
    bubble.style.top = `${top}px`;
    bubble.style.left = `${left}px`;

    rafId = requestAnimationFrame(track);
  }
  track();
  return true;
}

function onMessage(message, sender, sendResponse) {
  if (message.type === `guideme${VERSION}:scan`) {
    sendResponse({ elements: scanElements(), title: document.title, url: location.href, version: VERSION });
  } else if (message.type === `guideme${VERSION}:highlight`) {
    sendResponse({ ok: highlight(message.id, message.instruction) });
  } else if (message.type === `guideme${VERSION}:clear`) {
    clearHighlight();
    sendResponse({ ok: true });
  }
}
chrome.runtime.onMessage.addListener(onMessage);

window.__guidemeCleanup = () => {
  clearHighlight();
  chrome.runtime.onMessage.removeListener(onMessage);
};

console.log(`[GuideMe] content script v${VERSION} loaded`);
})();
