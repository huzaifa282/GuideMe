// Wrapped so it can be injected again (via chrome.scripting) without redeclaration errors.
// A newer version replaces an older copy already running in the page. Message types carry
// the version, so a stale copy that is still alive never answers a newer panel.
(() => {
const VERSION = 15;
if (window.__guidemeVersion === VERSION) return;
if (window.__guidemeCleanup) window.__guidemeCleanup();
window.__guidemeVersion = VERSION;

const MAX_ELEMENTS = 400; // interactive elements sent to the panel (the panel ranks them by relevance)
const MAX_INFO = 40; // contact details + headings
const MAX_PARAS = 80; // short blocks of page text (the panel keeps only the ones relevant to the goal)
const PARA_TEXT = 160;
const MAX_TEXT = 50;
const INFO_TEXT = 80; // contact snippets get more room so the full phone/email/address survives
const SELECTOR = 'button, a, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem]';

let overlayHost = null;
let pillHost = null;
let rafId = null;

// Live dropdown guidance state (only used while a session is active).
let session = null; // { targetId } while a goal session is running
let knownVisible = new WeakSet(); // nav items that were visible at the last check
let liveMenu = null; // { items: Element[], menu: string, active: boolean } for the open submenu
let currentHighlight = null; // { id, instruction, step } from the Navigator
let highlightedEl = null; // the element the Navigator's ring is on (not a dropdown option)
let lastClickAt = 0;
const strippedTargets = new Map(); // link -> its original target attribute, restored when the session ends // when the user last clicked a highlighted element
let previousHighlight = null; // Navigator highlight saved while a dropdown highlight is shown
let nextLiveId = 1000;
const liveIds = new WeakMap();
let ignoreUntil = 0; // our own menu opening/restoring causes mutations; ignore them briefly
let observer = null;
let checkTimer = null;
let clickWatch = null; // removes the click/change listeners on the highlighted element
let retryTimer = null;
let nextHint = ''; // what comes after this step (from the panel's look-ahead)
let nextEl = null; // the card's "Next:" line while an overlay is shown
let uiLang = 'en'; // language of the user's goal: en | roman | ur (set by the side panel)

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

// Rendered and non-empty (anywhere on the page, not only in the viewport).
function isRendered(el) {
  if (el.matches('input[type=hidden]')) return false;
  if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function centreInViewport(rect) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;
}

// "in view" when the centre is on screen, otherwise "below" or "above" the viewport.
function viewOf(rect) {
  if (centreInViewport(rect)) return 'in view';
  return rect.top + rect.height / 2 < 0 ? 'above' : 'below';
}

const MODAL_SELECTOR = 'dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]';

// The open modal that covers the page, if any (the last visible one in DOM order is the topmost).
function findModal() {
  const viewportArea = window.innerWidth * window.innerHeight;
  let modal = null;
  for (const el of document.querySelectorAll(MODAL_SELECTOR)) {
    if (!isRendered(el)) continue;
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    if (w > 0 && h > 0 && w * h > viewportArea * 0.1) modal = el;
  }
  return modal;
}

// Zone from the closest landmark ancestor, falling back to the position on the page.
function zoneOf(el, rect) {
  if (el.closest(MODAL_SELECTOR)) return 'modal';
  if (el.closest('header, nav, [role=banner], [role=navigation]')) return 'header/nav';
  if (el.closest('footer, [role=contentinfo]')) return 'footer';
  const pageTop = rect.top + window.scrollY;
  const pageHeight = document.documentElement.scrollHeight;
  if (pageTop < 100) return 'header/nav';
  if (pageHeight > window.innerHeight * 1.5 && pageTop > pageHeight - 300) return 'footer';
  return 'main';
}

// Order: modal, in view, then main, header/nav, footer.
function rankOf(item) {
  if (item.zone === 'modal') return 0;
  if (item.view === 'in view') return 1;
  return { main: 2, 'header/nav': 3, footer: 4 }[item.zone] ?? 2;
}

const PHONE_RE = /(?:\+?\d[\d\s().-]{5,}\d)/;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const ADDRESS_RE =
  /\b\d{1,5}[\s,]+[\w.]+(?:\s[\w.]+){0,3}\s(?:street|st|road|rd|avenue|ave|lane|ln|boulevard|blvd|drive|dr|block|sector|campus|highway|hwy)\b|\bP\.?\s?O\.?\s?Box\s+\d+/i;

function contactMatch(text) {
  const phone = text.match(PHONE_RE);
  const isYearRange = phone && /^(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}$/.test(phone[0].trim());
  if (phone && !isYearRange && phone[0].replace(/\D/g, '').length >= 7) return phone;
  return text.match(EMAIL_RE) || text.match(ADDRESS_RE);
}

function snippetAround(text, match, max) {
  if (text.length <= max) return text;
  const start = Math.max(0, Math.min(match.index - 15, text.length - max));
  return text.slice(start, start + max);
}

// Non-clickable but useful text: contact details (phone, email, address) and h1-h3 headings.
function collectInfo(scope, taken, limit) {
  const contacts = [];
  const headings = [];
  const seen = new Set();
  const add = (list, el, text) => {
    const key = text.toLowerCase();
    if (!text || seen.has(key) || el.hasAttribute('data-guideme-id') || taken.has(el)) return;
    seen.add(key);
    list.push({ el, text, kind });
  };
  let kind = 'contact';

  kind = 'heading';
  for (const h of scope.querySelectorAll('h1, h2, h3')) {
    if (headings.length >= limit || !isRendered(h)) continue;
    add(headings, h, (h.innerText || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT));
  }

  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      /script|style|noscript|textarea/i.test(node.parentElement?.tagName || '') || !node.nodeValue.trim()
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node && contacts.length < limit; node = walker.nextNode()) {
    const text = node.nodeValue.replace(/\s+/g, ' ').trim();
    const match = text.length <= 400 && contactMatch(text);
    const parent = node.parentElement;
    if (!match || !parent || !isRendered(parent)) continue;
    if (parent.closest(SELECTOR)) continue; // links and buttons are already in the element list
    kind = 'contact';
    add(contacts, parent, snippetAround(text, match, INFO_TEXT));
  }

  // Short blocks of readable text (fees, dates, requirements...). The panel keeps only relevant ones.
  kind = 'para';
  const paras = [];
  for (const block of scope.querySelectorAll('p, li, td, dd, address, figcaption, blockquote')) {
    if (paras.length >= MAX_PARAS) break;
    if (block.closest(SELECTOR) || block.querySelector('p, li, table')) continue;
    const text = (block.innerText || '').replace(/\s+/g, ' ').trim();
    if (text.length < 20 || !isRendered(block)) continue;
    add(paras, block, text.slice(0, PARA_TEXT));
  }

  // Contact details first, then headings, up to the limit; then the text blocks.
  return contacts.concat(headings).slice(0, limit).concat(paras);
}

const NAV_SELECTOR = 'header, nav, [role=navigation], [role=banner]';
const VISIBILITY_OPTS = { checkOpacity: true, checkVisibilityCSS: true };
const MAX_HIDDEN_SCAN = 80; // hidden dropdown items collected per scan
const MAX_OPTIONS = 15; // <select> option texts sent
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// id -> { trigger, menu, text } for hidden dropdown items found by the last scan.
let hiddenMenus = new Map();

// A hidden link/button under a nav item: returns the visible trigger that opens its submenu.
// The hidden submenu root is the topmost hidden ancestor; the trigger is a visible sibling of it.
function findMenuTrigger(el) {
  let submenu = el;
  while (
    submenu.parentElement &&
    !submenu.parentElement.matches(`${NAV_SELECTOR}, body`) &&
    !submenu.parentElement.checkVisibility(VISIBILITY_OPTS)
  ) {
    submenu = submenu.parentElement;
  }
  const label = (node) => clip(node.innerText || node.getAttribute('aria-label') || '', 30);
  const pick = (parent) => {
    for (const child of parent.children) {
      if (child === submenu || child.contains(el) || !isRendered(child) || !label(child)) continue;
      return child.matches(SELECTOR) ? child : child.querySelector(SELECTOR) || child;
    }
    return null;
  };
  const parent = submenu.parentElement;
  if (!parent) return null;
  let trigger = pick(parent);
  const li = parent.closest('li');
  if (!trigger && li && li !== parent) trigger = pick(li);
  return trigger ? { trigger, menu: label(trigger) } : null;
}

// Text for an element. Fields never send what the user typed (privacy): only their label.
const BUTTON_INPUTS = /^(submit|button|reset)$/i;
function fieldLabel(el) {
  const label = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('title') || el.name || '';
  return clip(label, MAX_TEXT);
}
function textOf(el, tag) {
  if (tag === 'select') return selectLabel(el);
  if (tag === 'textarea' || (tag === 'input' && !BUTTON_INPUTS.test(el.type))) {
    const kind = tag === 'input' && el.type && el.type !== 'text' ? ` (${el.type})` : '';
    const label = fieldLabel(el);
    return label ? `${label}${kind}` : '';
  }
  return clip(el.innerText || el.value || el.getAttribute('title'), MAX_TEXT);
}

// Where a link goes, as a short path (a strong hint about what it does). '' for buttons or "#" links.
function hrefOf(el) {
  const link = el.tagName === 'A' ? el : el.closest('a');
  const raw = link && link.getAttribute('href');
  if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) return '';
  try {
    return new URL(raw, location.href).href;
  } catch {
    return '';
  }
}

// The section an element sits in (its heading or label), e.g. "Undergraduate Programs".
function contextOf(el) {
  const box = el.closest('section, article, form, fieldset, aside, [role=region], [role=form]');
  if (!box) return '';
  const heading = box.getAttribute('aria-label') || (box.querySelector('h1, h2, h3, h4, legend') || {}).innerText || '';
  return clip(heading, 30);
}

// Name for a <select>: aria-label, its <label>, the name/id, or a generic word.
function selectLabel(el) {
  const label = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.name || el.id || 'Select';
  return clip(label, MAX_TEXT);
}

function scanElements() {
  document.querySelectorAll('[data-guideme-id]').forEach((el) => el.removeAttribute('data-guideme-id'));
  hiddenMenus = new Map();

  const modal = findModal();
  const scope = modal || document.body;
  const collected = [];
  const seen = new Set();
  const taken = new Set();
  const hiddenCandidates = [];

  const keyOf = (el, tag, text, ariaLabel, placeholder) =>
    `${tag}|${text.toLowerCase()}|${el.getAttribute('href') || ''}|${text ? '' : ariaLabel + '|' + placeholder}`;

  for (const el of scope.querySelectorAll(SELECTOR)) {
    if (!isRendered(el)) {
      // Not shown right now: keep links/buttons that live in navigation (possible dropdown items).
      if (hiddenCandidates.length < MAX_HIDDEN_SCAN && el.closest(NAV_SELECTOR)) hiddenCandidates.push(el);
      continue;
    }
    const rect = el.getBoundingClientRect();
    const view = viewOf(rect);
    // On screen, skip anything covered by another element (e.g. a sticky bar or overlay).
    if (view === 'in view' && !modal) {
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!top || !(top === el || el.contains(top) || top.contains(el))) continue;
    }

    const tag = el.tagName.toLowerCase();
    const isSelect = tag === 'select';
    const text = textOf(el, tag);
    const ariaLabel = el.getAttribute('aria-label') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    if (!text && !ariaLabel && !placeholder) continue;

    const key = keyOf(el, tag, text, ariaLabel, placeholder);
    if (seen.has(key)) continue;
    seen.add(key);

    const zone = modal ? 'modal' : zoneOf(el, rect);
    const item = { el, tag, text, ariaLabel, placeholder, zone, view, menu: '', options: [], href: hrefOf(el), context: zone === 'main' || zone === 'modal' ? contextOf(el) : '' };
    if (el.required || el.getAttribute('aria-required') === 'true') item.required = true;
    if (isSelect) {
      item.options = [...el.options].slice(0, MAX_OPTIONS + 1).map((o) => clip(o.textContent, 30)).filter(Boolean);
    }
    item.rank = rankOf(item);
    collected.push(item);
    taken.add(el);
  }

  // Hidden dropdown items come after the visible ones, so a visible duplicate always wins the dedupe.
  for (const el of hiddenCandidates) {
    const found = findMenuTrigger(el);
    if (!found) continue;
    const tag = el.tagName.toLowerCase();
    const text = clip(el.textContent || el.getAttribute('aria-label'), MAX_TEXT);
    if (!text) continue;
    const key = keyOf(el, tag, text, '', '');
    if (seen.has(key)) continue;
    seen.add(key);

    const item = { el, tag, text, ariaLabel: '', placeholder: '', zone: modal ? 'modal' : 'header/nav', view: 'hidden', menu: found.menu, options: [], href: hrefOf(el), context: '' };
    item.rank = rankOf(item);
    item.trigger = found.trigger;
    collected.push(item);
  }

  const elements = collected.sort((a, b) => a.rank - b.rank).slice(0, MAX_ELEMENTS);

  const info = collectInfo(scope, taken, MAX_INFO).map(({ el, text, kind }) => {
    const rect = el.getBoundingClientRect();
    const item = { el, tag: 'info', kind, text, ariaLabel: '', placeholder: '', zone: modal ? 'modal' : zoneOf(el, rect), view: viewOf(rect), menu: '', options: [], href: '', context: '' };
    item.rank = rankOf(item);
    return item;
  });

  const items = elements.concat(info).sort((a, b) => a.rank - b.rank);
  const out = items.map((item, i) => {
    const id = String(i + 1);
    item.el.setAttribute('data-guideme-id', id);
    if (item.trigger) hiddenMenus.set(id, { trigger: item.trigger, menu: item.menu, text: item.text });
    const { tag, kind, text, ariaLabel, placeholder, zone, view, menu, options, href, context, required } = item;
    return { id, tag, kind: kind || '', text, ariaLabel, placeholder, zone, view, menu, menuId: '', options, moreOptions: tag === 'select' && options.length > MAX_OPTIONS, href, context, required: !!required };
  });
  // Second pass, once every scanned item has its id: a hidden item's menuId is its trigger's id
  // (the trigger gets a live id if it did not make it into the list).
  items.forEach((item, i) => {
    if (item.trigger) out[i].menuId = liveIdOf(item.trigger);
  });
  return out;
}

// --- Dropdown menus: open a hidden submenu, and put everything back when the overlay closes. ---
const FORCED_PROPS = ['display', 'visibility', 'opacity'];
let forcedStyles = []; // { node, saved: { prop: [value, priority] } }
let openedTriggers = []; // elements we sent hover/focus events to

function fireHover(node) {
  node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true, view: window }));
  node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
}

function fireLeave(node) {
  node.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true, view: window }));
  node.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, view: window }));
}

// Simulates hovering and focusing the trigger (and its parent li) so the site's own script opens the menu.
function openMenuEvents(trigger) {
  const targets = [trigger, trigger.closest('li')].filter(Boolean);
  for (const node of targets) fireHover(node);
  try {
    trigger.focus({ preventScroll: true });
  } catch {}
  trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  openedTriggers = targets;
}

// Last resort: show the hidden ancestors of `el` with inline styles, remembering the originals.
function forceVisible(el, stopAt) {
  for (let node = el; node && node !== stopAt && node !== document.body; node = node.parentElement) {
    const cs = getComputedStyle(node);
    if (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0') continue;
    const saved = {};
    for (const prop of FORCED_PROPS) saved[prop] = [node.style.getPropertyValue(prop), node.style.getPropertyPriority(prop)];
    forcedStyles.push({ node, saved });
    node.style.setProperty('display', 'block', 'important');
    node.style.setProperty('visibility', 'visible', 'important');
    node.style.setProperty('opacity', '1', 'important');
  }
}

function restoreMenu() {
  if (forcedStyles.length > 0 || openedTriggers.length > 0) ignoreUntil = Date.now() + 400;
  for (const { node, saved } of forcedStyles.reverse()) {
    for (const prop of FORCED_PROPS) {
      const [value, priority] = saved[prop];
      if (value) node.style.setProperty(prop, value, priority);
      else node.style.removeProperty(prop);
    }
  }
  forcedStyles = [];
  for (const node of openedTriggers) fireLeave(node);
  openedTriggers = [];
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shown = (el) => isRendered(el);

// Makes a hidden dropdown item visible. Resolves true if it is visible afterwards.
async function openMenuFor(el, trigger) {
  ignoreUntil = Date.now() + 1000;
  openMenuEvents(trigger);
  await wait(300);
  if (shown(el)) return true;
  forceVisible(el, trigger.closest('li') || trigger.parentElement);
  await wait(50);
  return shown(el);
}

function clearHighlight() {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  document.removeEventListener('keydown', onKeydown, true);
  stopWatchingClicks();
  if (overlayHost) overlayHost.remove();
  overlayHost = null;
  nextEl = null;
  restoreMenu();
}

// The user (or the panel) closed the overlay: forget any highlight we would otherwise restore.
function dismissOverlay() {
  currentHighlight = null;
  highlightedEl = null;
  previousHighlight = null;
  if (liveMenu) liveMenu.active = false;
  clearHighlight();
}

function onKeydown(e) {
  if (e.key === 'Escape') dismissOverlay();
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
  .next { margin-top: 8px; padding-top: 8px; border-top: 1px solid #e5e7eb; font-size: 12.5px; color: #4f46e5; }
  .next b { font-weight: 700; }
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
  .step.error { color: #dc2626; }
  .retry {
    margin-top: 10px;
    padding: 6px 14px;
    border: 0;
    border-radius: 8px;
    background: #10b981;
    color: #fff;
    font: 600 14px system-ui, sans-serif;
    cursor: pointer;
  }
  [hidden] { display: none !important; }
  @media (prefers-reduced-motion: reduce) {
    .ring, .card { transition: none; animation: none; }
    .ring::after { animation: none; }
  }
`;

// Resolves to { ok, instruction } where instruction is what the card actually shows.
async function highlight(id, instruction, step, live = false) {
  clearHighlight();
  hideStatus();
  let el = document.querySelector(`[data-guideme-id="${id}"]`);
  if (!el) return { ok: false, instruction };
  // Remember the Navigator's highlight so it can come back when a dropdown highlight closes.
  if (!live) {
    currentHighlight = { id, instruction, step };
    previousHighlight = null;
    if (liveMenu) liveMenu.active = false; // a fresh Navigator step replaces any dropdown highlight
  }

  // A hidden dropdown item: open its menu first, with a plain wording the user can follow.
  const hidden = hiddenMenus.get(String(id));
  if (hidden && !shown(el)) {
    // Keep Gemma's wording (it is in the user's language) when it already names the item.
    const named = instruction && instruction.toLowerCase().includes(hidden.text.toLowerCase());
    if (await openMenuFor(el, hidden.trigger)) {
      if (!named) instruction = menuWords(hidden.menu, hidden.text);
    } else {
      // The menu would not open: point at the visible trigger instead.
      restoreMenu();
      el = hidden.trigger;
      if (!named || !instruction.toLowerCase().includes(hidden.menu.toLowerCase())) instruction = hoverWords(hidden.menu, hidden.text);
    }
  }

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
      <div class="notice" hidden></div>
      <div class="next" hidden><b></b> <span></span></div>
      <div class="footer">GuideMe</div>
      <button class="close" type="button" aria-label="Close">×</button>
    </div>`;
  const ring = shadow.querySelector('.ring');
  nextEl = shadow.querySelector('.next');
  nextEl.querySelector('b').textContent = t('next');
  showNext(nextHint);
  const badge = shadow.querySelector('.badge');
  const card = shadow.querySelector('.card');
  const notice = shadow.querySelector('.notice');
  notice.textContent = t('scroll');
  const stepNumber = step || 1;
  badge.textContent = stepNumber;
  shadow.querySelector('.step').textContent = `${t('step')} ${stepNumber}`;
  shadow.querySelector('.text').textContent = instruction;
  // Right-to-left scripts (Urdu, Arabic, Hebrew) flip the card.
  card.dir = uiLang === 'ur' || /[֐-ࣿ]/.test(instruction) ? 'rtl' : 'ltr';
  shadow.querySelector('.close').addEventListener('click', dismissOverlay);
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
  // Scroll first, then draw: the ring and badge stay hidden until the smooth scroll has settled
  // (the element's position stops changing), so footer items never flash in the wrong place.
  const startedAt = performance.now();
  let lastTop = null;
  let lastLeft = null;
  let lastMoved = startedAt;
  let settled = false;
  function track() {
    const r = el.getBoundingClientRect();
    const now = performance.now();
    if (r.top !== lastTop || r.left !== lastLeft) lastMoved = now;
    lastTop = r.top;
    lastLeft = r.left;
    if (!settled && (now - lastMoved > 150 || now - startedAt > 2500)) settled = true;

    const inView = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    const showRing = settled && inView;

    ring.hidden = badge.hidden = !showRing;
    notice.hidden = !settled || inView;
    if (showRing) {
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
  openInSameTab(el);
  watchClicks(el);
  if (!live) highlightedEl = el;
  // Menus we opened or forced are not "new" dropdowns for the watcher.
  ignoreUntil = Date.now() + 400;
  snapshotVisible();
  return { ok: true, instruction };
}

// "Under MENU, click 'ITEM'" in the user's language (en, Roman Urdu, Urdu script).
function menuWords(menu, item) {
  const lang = uiLang;
  if (lang === 'roman') return `${menu} menu mein '${item}' par click karein`;
  if (lang === 'ur') return `${menu} مینو میں '${item}' پر کلک کریں`;
  return `Under ${menu}, click '${item}'`;
}

// Fixed card wording in the user's language (en, Roman Urdu, Urdu script).
const TEXT = {
  step: { en: 'Step', roman: 'Qadam', ur: 'مرحلہ' },
  done: { en: 'All done!', roman: 'Ho gaya!', ur: 'مکمل ہو گیا!' },
  next: { en: 'Next:', roman: 'Agla:', ur: 'اگلا:' },
  scroll: { en: 'Scroll to see the highlighted item', roman: 'Highlight ki hui cheez dekhne ke liye scroll karein', ur: 'نمایاں چیز دیکھنے کے لیے سکرول کریں' },
  error: { en: 'Something went wrong', roman: 'Kuch ghalat ho gaya', ur: 'کچھ غلط ہو گیا' },
  retry: { en: 'Retry', roman: 'Dobara koshish', ur: 'دوبارہ کوشش کریں' },
};
const t = (key) => TEXT[key][uiLang] || TEXT[key].en;
function hoverWords(menu, item) {
  if (uiLang === 'roman') return `${menu} par mouse le jayein, phir '${item}' par click karein`;
  if (uiLang === 'ur') return `${menu} پر ماؤس لے جائیں، پھر '${item}' پر کلک کریں`;
  return `Hover ${menu}, then click '${item}'`;
}

function showNext(text) {
  nextHint = text || '';
  if (!nextEl) return;
  nextEl.querySelector('span').textContent = nextHint;
  nextEl.dir = /[֐-ࣿ]/.test(nextHint) ? 'rtl' : 'ltr';
  nextEl.hidden = !nextHint;
}

// --- Live dropdown guidance: while a session is active, notice submenus the user opens. ---
const CHECK_DEBOUNCE_MS = 250;
const MAX_NAV_ITEMS = 600;

const navItems = () =>
  [...document.querySelectorAll(SELECTOR)].filter((el) => el.closest(NAV_SELECTOR)).slice(0, MAX_NAV_ITEMS);

const labelOf = (node) => clip(node.innerText || node.textContent || node.getAttribute('aria-label') || '', 30);

// Remember which nav items are visible right now, so later checks can spot ones that just appeared.
function snapshotVisible() {
  knownVisible = new WeakSet();
  if (!session) return;
  for (const el of navItems()) if (isRendered(el)) knownVisible.add(el);
}

// Given an item that just became visible, find the submenu it belongs to and the trigger that opened it:
// the trigger is a sibling (at some ancestor level) that was already visible before.
function findOpenedSubmenu(item, wasKnown) {
  for (let node = item; node.parentElement && node !== document.body; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node || sibling.contains(item)) continue;
      const trigger = sibling.matches(SELECTOR) ? sibling : sibling.querySelector(SELECTOR);
      if (trigger && wasKnown.has(trigger) && isRendered(trigger) && labelOf(trigger)) {
        return { root: node, trigger, menu: labelOf(trigger) };
      }
    }
  }
  return null;
}

// Every item gets an id the panel can refer to: its scan id if it has one, otherwise a stable live id.
function liveIdOf(el) {
  const existing = el.getAttribute('data-guideme-id');
  if (existing) return existing;
  if (!liveIds.has(el)) liveIds.set(el, String(nextLiveId++));
  const id = liveIds.get(el);
  el.setAttribute('data-guideme-id', id);
  return id;
}

function describeItem(el) {
  return {
    id: liveIdOf(el),
    tag: el.tagName.toLowerCase(),
    text: clip(el.innerText || el.value || el.getAttribute('aria-label'), MAX_TEXT),
    ariaLabel: el.getAttribute('aria-label') || '',
    placeholder: el.getAttribute('placeholder') || '',
    zone: 'header/nav',
    view: 'in view',
    menu: '',
    options: [],
    href: hrefOf(el),
  };
}

function tellPanel(payload) {
  chrome.runtime
    .sendMessage({ ...payload, title: document.title, url: location.href, type: `guideme${VERSION}:dropdown` })
    .catch(() => {});
}

// Step numbers follow the panel's session.step. Opening the submenu of the step's target (its trigger)
// completes that step, so the option shows the next one.
function tellStep(from, to) {
  chrome.runtime.sendMessage({ type: `guideme${VERSION}:step`, from, to }).catch(() => {});
}

// Is the Navigator's ring on the trigger of the submenu that is open now?
function targetIsTriggerOfOpenMenu() {
  const trigger = liveMenu && liveMenu.trigger;
  return !!(trigger && highlightedEl && (highlightedEl === trigger || trigger.contains(highlightedEl) || highlightedEl.contains(trigger)));
}

// Put the ring on a dropdown option. The Navigator's own highlight is saved and comes back on close.
function showLiveHighlight(id, instruction) {
  if (!previousHighlight && currentHighlight) previousHighlight = currentHighlight;
  if (liveMenu) liveMenu.active = true;
  // Advance once per opened menu: re-hovering the same menu (still open) never counts again.
  if (liveMenu && !liveMenu.advanced && targetIsTriggerOfOpenMenu()) {
    liveMenu.advanced = true;
    liveMenu.fromStep = session.step;
    session.step += 1;
    tellStep(liveMenu.fromStep, session.step);
  }
  // Any other menu (e.g. a prefetched pick on a menu that was not the target) keeps the current step.
  return highlight(id, instruction, session.step, true);
}

// The submenu closed: drop the dropdown ring and bring back the previous highlight, if any.
function closeLiveMenu() {
  const menu = liveMenu;
  liveMenu = null;
  if (!menu || !menu.active) return;
  // Closed without the option being clicked: go back a step (a click ends the step for good).
  if (menu.advanced && Date.now() - lastClickAt > 2000) {
    session.step = menu.fromStep;
    tellStep(menu.fromStep + 1, menu.fromStep);
  }
  const previous = previousHighlight;
  previousHighlight = null;
  clearHighlight();
  if (previous) highlight(previous.id, previous.instruction, session.step);
}

function checkDropdowns() {
  if (!session) return;
  if (Date.now() < ignoreUntil) {
    scheduleCheck();
    return;
  }

  // 1. Has the open submenu closed?
  if (liveMenu && !liveMenu.items.some((el) => el.isConnected && isRendered(el))) closeLiveMenu();

  // 2. Did a new submenu open?
  const wasKnown = knownVisible;
  const fresh = navItems().filter((el) => isRendered(el) && !wasKnown.has(el));
  snapshotVisible();
  if (fresh.length === 0) return;

  const found = findOpenedSubmenu(fresh[0], wasKnown);
  if (!found) return;
  const submenuItems = [...found.root.querySelectorAll(SELECTOR)].filter((el) => isRendered(el) && labelOf(el));
  if (submenuItems.length === 0) return;
  if (liveMenu && liveMenu.root === found.root) return; // same menu, already handled

  // Were these items part of the Start scan (scan ids are below 1000)? If not, they loaded lazily.
  const inScan = submenuItems.some((el) => Number(el.getAttribute('data-guideme-id')) > 0 && Number(el.getAttribute('data-guideme-id')) < 1000);
  const items = submenuItems.map(describeItem);
  liveMenu = { items: submenuItems, menu: found.menu, root: found.root, trigger: found.trigger, active: false, advanced: false, fromStep: 0 };

  // 2a. The Navigator's target is inside this submenu: highlight it now, no API call.
  const target = session.targetId && items.find((item) => item.id === session.targetId);
  if (target) {
    const said = menuWords(found.menu, target.text);
    showLiveHighlight(target.id, said);
    tellPanel({ parent: found.menu, handled: true, item: target.text, instruction: said });
    return;
  }

  // 2b. The first Gemma call already picked the best item of this menu (menuPicks): highlight it, no API call.
  const pick = session.menuPicks.find((p) => items.some((item) => item.id === p.itemId));
  if (pick) {
    const picked = items.find((item) => item.id === pick.itemId);
    const said = menuWords(found.menu, picked.text);
    showLiveHighlight(picked.id, said);
    tellPanel({ parent: found.menu, handled: true, prefetched: true, item: picked.text, instruction: said });
    return;
  }

  // 2c. Its items were in the Start scan but nothing in them fits the goal: nothing to show.
  if (inScan) {
    tellPanel({ parent: found.menu, handled: true, skipped: true });
    return;
  }

  // 2d. Lazily loaded menu: the panel asks Gemma about just these items and replies with 'live-highlight'.
  tellPanel({ parent: found.menu, handled: false, items });
}

function scheduleCheck(withRetry = false) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(checkDropdowns, CHECK_DEBOUNCE_MS);
  // Pure-CSS menus open without any DOM change, so look once more after the transition.
  if (withRetry) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(checkDropdowns, CHECK_DEBOUNCE_MS + 350);
  }
}

function onNavEvent(e) {
  if (!session) return;
  const target = e.target;
  const inNav = target && target.closest && target.closest(NAV_SELECTOR);
  if (inNav || liveMenu) scheduleCheck(e.type === 'mouseover' || e.type === 'focusin');
}

function onMutations(records) {
  if (!session || Date.now() < ignoreUntil) return;
  if (records.some((r) => r.target.nodeType === 1 && r.target.closest(NAV_SELECTOR))) scheduleCheck();
}

const NAV_EVENTS = ['mouseover', 'focusin', 'mouseout', 'focusout'];

function setSession(active, targetId, menuPicks, step, lang) {
  if (!active) {
    session = null;
    liveMenu = null;
    previousHighlight = null;
    restoreTargets();
    if (observer) observer.disconnect();
    observer = null;
    clearTimeout(checkTimer);
    clearTimeout(retryTimer);
    NAV_EVENTS.forEach((type) => document.removeEventListener(type, onNavEvent, true));
    return;
  }
  const wasActive = !!session;
  session = { targetId: targetId || null, menuPicks: Array.isArray(menuPicks) ? menuPicks : [], step: step || 1, lang: lang || 'en' };
  if (wasActive) return; // already watching; only the target and picks changed
  snapshotVisible();
  NAV_EVENTS.forEach((type) => document.addEventListener(type, onNavEvent, true));
  observer = new MutationObserver(onMutations);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'aria-expanded', 'aria-hidden', 'open'],
  });
}

// --- Links that open a new tab would take the user out of the session's tab. ---
const linkOf = (el) => (el.tagName === 'A' ? el : el.closest('a'));
const opensNewTab = (link) => String(link.getAttribute('target') || '').toLowerCase() === '_blank';

// While a session is active, take target="_blank" off the highlighted link (original remembered).
function openInSameTab(el) {
  const link = session && linkOf(el);
  if (!link || !opensNewTab(link) || strippedTargets.has(link)) return;
  strippedTargets.set(link, link.getAttribute('target'));
  link.removeAttribute('target');
}

function restoreTargets() {
  for (const [link, target] of strippedTargets) link.setAttribute('target', target);
  strippedTargets.clear();
}

// Safety net: if the clicked link still has target="_blank", open it in this tab ourselves.
function keepInSameTab(e, el) {
  const link = linkOf(el) || (e.target.closest && e.target.closest('a'));
  if (!link || !opensNewTab(link) || !link.href) return;
  // Leave deliberate "open elsewhere" clicks alone (ctrl/cmd/shift/middle click) and downloads.
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0 || link.hasAttribute('download')) return;
  if (!/^https?:$/.test(link.protocol)) return;
  e.preventDefault();
  console.log('[GuideMe] Opening in same tab');
  chrome.runtime.sendMessage({ type: `guideme${VERSION}:log`, text: 'Opening in same tab' }).catch(() => {});
  window.location.href = link.href;
}

// --- Reporting the user's click on the highlighted element, before the page can change. ---
function stopWatchingClicks() {
  if (clickWatch) clickWatch();
  clickWatch = null;
}

// Tells the panel once when the user clicks the highlighted element (or changes it, for a select).
function watchClicks(el) {
  stopWatchingClicks();
  if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !BUTTON_INPUTS.test(el.type) && !/^(checkbox|radio)$/i.test(el.type))) {
    // Never report what the user typed: only that the field was filled.
    const onChange = () =>
      report(el.tagName === 'SELECT' ? `Chose '${clip(el.selectedOptions[0] && el.selectedOptions[0].textContent, 40)}'` : `Filled '${fieldLabel(el) || 'the field'}'`);
    el.addEventListener('change', onChange);
    clickWatch = () => el.removeEventListener('change', onChange);
    return;
  }
  if (!el.matches(SELECTOR)) return; // info snippets are not clickable
  const onClick = (e) => {
    if (e.target instanceof Node && (el === e.target || el.contains(e.target))) {
      report(clip(el.innerText || el.value || el.getAttribute('aria-label'), 40));
      keepInSameTab(e, el);
    }
  };
  document.addEventListener('click', onClick, true);
  clickWatch = () => document.removeEventListener('click', onClick, true);

  function report(text) {
    stopWatchingClicks();
    lastClickAt = Date.now();
    chrome.runtime
      .sendMessage({ type: `guideme${VERSION}:clicked`, text, url: location.href })
      .catch(() => {});
  }
}

// Final "All done!" card: no ring, just the card (Esc or the close button removes it).
function showDoneCard(text) {
  clearHighlight();
  hideStatus();
  currentHighlight = null;
  previousHighlight = null;
  overlayHost = document.createElement('div');
  overlayHost.id = 'guideme-overlay';
  overlayHost.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const shadow = overlayHost.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${OVERLAY_CSS}</style>
    <div class="card" role="status">
      <div class="step"></div>
      <div class="text"></div>
      <div class="footer">GuideMe</div>
      <button class="close" type="button" aria-label="Close">×</button>
    </div>`;
  const card = shadow.querySelector('.card');
  shadow.querySelector('.step').textContent = t('done');
  shadow.querySelector('.text').textContent = text;
  card.dir = uiLang === 'ur' || /[֐-ࣿ]/.test(text) ? 'rtl' : 'ltr';
  shadow.querySelector('.close').addEventListener('click', dismissOverlay);
  document.documentElement.appendChild(overlayHost);
  document.addEventListener('keydown', onKeydown, true);
}

// A failed step: the card explains it and offers Retry, which resumes from the current step.
function showErrorCard(text) {
  clearHighlight();
  hideStatus();
  currentHighlight = null;
  previousHighlight = null;
  overlayHost = document.createElement('div');
  overlayHost.id = 'guideme-overlay';
  overlayHost.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const shadow = overlayHost.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${OVERLAY_CSS}</style>
    <div class="card" role="alert">
      <div class="step error"></div>
      <div class="text"></div>
      <button class="retry" type="button"></button>
      <div class="footer">GuideMe</div>
      <button class="close" type="button" aria-label="Close">×</button>
    </div>`;
  shadow.querySelector('.step').textContent = t('error');
  shadow.querySelector('.retry').textContent = t('retry');
  shadow.querySelector('.text').textContent = text;
  shadow.querySelector('.card').dir = uiLang === 'ur' ? 'rtl' : 'ltr';
  shadow.querySelector('.close').addEventListener('click', dismissOverlay);
  shadow.querySelector('.retry').addEventListener('click', () => {
    dismissOverlay();
    chrome.runtime.sendMessage({ type: `guideme${VERSION}:retry` }).catch(() => {});
  });
  document.documentElement.appendChild(overlayHost);
  document.addEventListener('keydown', onKeydown, true);
}

function onMessage(message, sender, sendResponse) {
  if (message.lang) uiLang = message.lang; // every panel message may carry the goal's language
  if (message.type === `guideme${VERSION}:scan`) {
    sendResponse({ elements: scanElements(), title: document.title, url: location.href, version: VERSION });
  } else if (message.type === `guideme${VERSION}:next`) {
    showNext(message.text);
    sendResponse({ ok: true });
  } else if (message.type === `guideme${VERSION}:highlight`) {
    nextHint = message.next || '';
    highlight(message.id, message.instruction, message.step)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, instruction: message.instruction, error: String(err && err.message) }));
    return true; // the reply is sent after the menu has been opened
  } else if (message.type === `guideme${VERSION}:clear`) {
    dismissOverlay();
    hideStatus();
    sendResponse({ ok: true });
  } else if (message.type === `guideme${VERSION}:done`) {
    showDoneCard(message.text);
    sendResponse({ ok: true });
  } else if (message.type === `guideme${VERSION}:error`) {
    showErrorCard(message.text);
    sendResponse({ ok: true });
  } else if (message.type === `guideme${VERSION}:session`) {
    setSession(message.active, message.targetId, message.menuPicks, message.step, message.lang);
    sendResponse({ ok: true });
  } else if (message.type === `guideme${VERSION}:live-highlight`) {
    // The panel picked an item from the dropdown that is open now.
    const el = document.querySelector('[data-guideme-id="' + message.id + '"]');
    const stillOpen = el && liveMenu && liveMenu.items.includes(el) && isRendered(el);
    if (stillOpen) showLiveHighlight(message.id, message.instruction);
    sendResponse({ ok: !!stillOpen });
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
  setSession(false);
  clearHighlight();
  hideStatus();
  chrome.runtime.onMessage.removeListener(onMessage);
};

console.log(`[GuideMe] content script v${VERSION} loaded`);
})();
