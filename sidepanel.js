const MODELS = ['gemma-4-26b-a4b-it', 'gemma-4-31b-it']; // keep in sync with options.html
const DEFAULT_MODEL = MODELS[0];
const modelUrl = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
// No responseMimeType: it makes Gemma return HTTP 500. Thinking is turned down instead.
const GENERATION_CONFIG = { temperature: 0, maxOutputTokens: 256 };
const THINKING_CONFIG = { thinkingLevel: 'minimal' };
const TIMEOUT_MS = 40000;
const MAX_LINE_TEXT = 40; // text per item in the prompt
const TOP_ITEMS = 60; // items sent on the first attempt (in-view items always included)
const MAX_IN_VIEW = 80; // safety cap for in-view items
const MAX_OPTIONS = 15; // <select> option texts per line
const MAX_MENU_PICKS = 5; // dropdown menus the first call may prefetch an answer for
const SMALL_LIST = 25; // items sent when retrying after a timeout or MAX_TOKENS

const INSTRUCTIONS = `You are GuideMe, a patient guide helping a non-technical user complete a goal on a website. Given the user's goal and the list of elements on the whole page, choose the ONE element the user should click or use next. If the goal is already achieved, use action finish. If no element fits, use action ask_user and explain what to do in the instruction.
Each line is: id|zone|tag|text, optionally followed by |aria:<label> or |ph:<placeholder>. Zone letters: H=header, M=main, F=footer, D=dialog, I=info. Lines with zone I are INFO snippets: text that is not clickable (headings, phone numbers, emails, addresses).
Items marked "menu: X (hidden)" are inside dropdowns. Prefer the specific dropdown item over its parent menu. Such a line ends with "|mid:N", where N is the id of the menu's trigger (the visible item that opens it).
Also fill "menuPicks": for each dropdown menu that contains an item relevant to the goal, give the best item in it as {"menuId": N, "itemId": id}, using the mid number as menuId. At most 5 menus; use [] if none.
A select line ends with "options: ..." listing its choices. To pick one, choose that select and write the choice in the instruction, e.g. "Choose 'BS Computer Science'".
Search the whole list, including footer items. Choose the most direct element even if it is in the footer.
If the user asks for information (phone, email, address, fees), find it in the INFO snippets, highlight that snippet, and put the actual answer in the instruction, e.g. "The admissions office number is 041-111-222."
The user message may include "History": the steps already done, each with the instruction given and the text the user clicked. Use it to judge "progress" before choosing the next element:
- "on_track": the last click moved toward the goal (also use this when there is no history yet).
- "off_track": the user ended up somewhere unhelpful; then choose the element that leads back and make the instruction guide them back.
- "done": the goal is already achieved; then use action finish.
Write a short, friendly instruction (max 15 words, unless the answer needs more). Keep "reason" to 12 words or fewer.
Output a single JSON object with this shape:
{"action":"highlight"|"finish"|"ask_user","elementId":number|null,"instruction":string,"reason":string,"progress":"on_track"|"off_track"|"done","menuPicks":[{"menuId":number,"itemId":number}]}

Example 1:
Goal: "I want to log in"
Elements:
1|H|a|Home
2|H|button|Sign in
Output: {"action":"highlight","elementId":2,"instruction":"Click 'Sign in' at the top.","reason":"This button opens the login form.","progress":"on_track","menuPicks":[]}

Example 2:
Goal: "How do I apply for admission?"
Elements:
10|H|a|ADMISSIONS
11|H|a|Undergraduate|menu: ADMISSIONS (hidden)|mid:10
12|H|a|Contact
Output: {"action":"highlight","elementId":10,"instruction":"Hover ADMISSIONS, then click 'Undergraduate'.","reason":"The admissions menu leads to applications.","progress":"on_track","menuPicks":[{"menuId":10,"itemId":11}]}`;

const FINAL_LINE =
  'Respond with ONLY the JSON object. Do not restate the goal or elements. No explanation, no markdown.';

const goalInput = document.getElementById('goal');
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const retryButton = document.getElementById('retry');
const logEl = document.getElementById('log');

function log(msg) {
  console.log('[GuideMe]', msg);
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  return line;
}

// In-memory cache of model decisions, keyed by page URL + goal + element-list hash.
const decisionCache = new Map();

function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Keeps a running average of response time per model so the two can be compared in Options.
async function recordTiming(model, ms) {
  const { timings = {} } = await chrome.storage.local.get('timings');
  const t = timings[model] || { count: 0, totalMs: 0 };
  timings[model] = { count: t.count + 1, totalMs: t.totalMs + ms, lastMs: ms };
  await chrome.storage.local.set({ timings });
}

function clean(value, max) {
  const s = String(value || '').replace(/[|\r\n]+/g, ' ').trim();
  return max ? s.slice(0, max) : s;
}

const ZONE_LETTER = { 'header/nav': 'H', main: 'M', footer: 'F', modal: 'D' };

// One compact line per item: id|zone|tag|text, plus aria-label / placeholder only when they
// differ from the text. Zone letters: H=header, M=main, F=footer, D=dialog, I=info.
function formatElements(elements) {
  return elements
    .map((e) => {
      const text = clean(e.text || e.ariaLabel || e.placeholder, MAX_LINE_TEXT);
      const zone = e.tag === 'info' ? 'I' : ZONE_LETTER[e.zone] || 'M';
      const aria = clean(e.ariaLabel, MAX_LINE_TEXT);
      const placeholder = clean(e.placeholder, MAX_LINE_TEXT);
      let line = `${e.id}|${zone}|${e.tag}|${text}`;
      if (e.menu) line += `|menu: ${clean(e.menu, 30)} (hidden)${e.menuId ? `|mid:${e.menuId}` : ''}`;
      if (e.options && e.options.length) {
        const shown = e.options.slice(0, MAX_OPTIONS).map((o) => clean(o, 30)).join(', ');
        line += `|options: ${shown}${e.moreOptions ? '...' : ''}`;
      }
      if (aria && aria !== text) line += `|aria:${aria}`;
      if (placeholder && placeholder !== text) line += `|ph:${placeholder}`;
      return line;
    })
    .join('\n');
}

// --- Local relevance ranking: keeps the request small enough for Gemma to answer in time. ---
const STOP_WORDS = new Set(
  'a an the to of for and or on in at by is are be i me my we you your it want need how do does can could would should please where what which find get go show take tell about with from this that'.split(' ')
);
// Groups of related terms: a goal word matching any member pulls in the whole group.
const SYNONYM_GROUPS = [
  ['contact', 'phone', 'email', 'contact us', 'call', 'address'],
  ['apply', 'admission', 'application', 'register', 'registration'],
  ['scholarship', 'financial aid', 'fee concession'],
  ['fee', 'voucher', 'challan', 'tuition'],
];
const CONTACT_WORDS = new Set(['contact', 'phone', 'email', 'call', 'address', 'number']);

const normWord = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

function goalTerms(goal) {
  const words = (goal.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
    .map(normWord);
  const synonyms = new Set();
  for (const group of SYNONYM_GROUPS) {
    if (words.some((w) => group.some((member) => member === w || member.split(' ').includes(w)))) {
      group.forEach((member) => synonyms.add(member));
    }
  }
  words.forEach((w) => synonyms.delete(w));
  return { words, synonyms: [...synonyms], wantsContact: words.some((w) => CONTACT_WORDS.has(w)) };
}

function scoreItem(item, terms) {
  const hay = `${item.text} ${item.ariaLabel} ${item.placeholder} ${item.menu || ''} ${(item.options || []).join(' ')}`.toLowerCase();
  let score = 0;
  for (const w of terms.words) if (hay.includes(w)) score += 2;
  for (const s of terms.synonyms) if (hay.includes(s)) score += 1;
  if (item.tag === 'info' && terms.wantsContact) score += 3;
  return score;
}

// Top `limit` items by relevance, in their original order. In-view items are always included
// (when forceInView is set), the rest are filled by score.
function selectItems(goal, elements, limit, forceInView) {
  if (elements.length <= limit) return elements;
  const terms = goalTerms(goal);
  const scored = elements.map((item, index) => ({ item, index, score: scoreItem(item, terms) }));
  const keep = new Set();
  if (forceInView) scored.filter((s) => s.item.view === 'in view').slice(0, MAX_IN_VIEW).forEach((s) => keep.add(s.index));
  const byScore = scored.slice().sort((a, b) => b.score - a.score || a.index - b.index);
  for (const s of byScore) {
    if (keep.size >= limit) break;
    keep.add(s.index);
  }
  return scored.filter((s) => keep.has(s.index)).map((s) => s.item);
}

// system = role, rules, example and the "ONLY the JSON object" line; user = just the goal and elements.
// Readable history for the prompt: where each step happened, what we said, what the user clicked.
function formatHistory(history) {
  return history
    .map((h, i) => `${i + 1}. [${shortUrl(h.url)}] ${clean(h.instruction, 80)} -> clicked "${clean(h.clickedText, 40)}"`)
    .join('\n');
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).slice(0, 60);
  } catch {
    return String(url || '').slice(0, 60);
  }
}

function buildPrompt(goal, title, url, list, progress) {
  const steps =
    progress && progress.history.length
      ? `Step: ${progress.step} of ${MAX_STEPS}\nHistory:\n${formatHistory(progress.history)}\n`
      : '';
  return {
    system: `${INSTRUCTIONS}\n\n${FINAL_LINE}`,
    user: `Page: ${title} (${url})\nGoal: ${JSON.stringify(goal)}\n${steps}Elements (id|zone|tag|text):\n${list}`,
  };
}

const CONTENT_VERSION = 13; // must match VERSION in content.js

// Always inject the current content.js first: it replaces any older copy still running in
// the page (e.g. a tab opened before the extension was reloaded), and is a no-op if current.
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (err) {
    throw new Error(`Cannot run on this page (${err.message}). Try a regular website.`);
  }
}

function sendToTab(tabId, type, payload) {
  return chrome.tabs.sendMessage(tabId, { ...payload, type: `guideme${CONTENT_VERSION}:${type}` });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isServerError = (err) => err.status >= 500 && err.status < 600;

const isNetworkError = (err) => err.name === 'TypeError' || /Failed to fetch/i.test(err.message);

// Failures worth retrying (and counting toward a model switch): HTTP 5xx and network errors.
const isRetryable = (err) => isServerError(err) || isNetworkError(err);

const BACKOFF_MS = [1000, 3000, 6000]; // waits between retries
const FAILURES_BEFORE_SWITCH = 2; // failures on one model before switching to the other

// One attempt. thinkingConfig is only dropped if the API answers 400 (it rejected the config itself).
// Every attempt goes through callGemma, which creates its own AbortController.
async function callOnce(apiKey, prompt, model, opts) {
  try {
    return await callGemma(apiKey, prompt, model, true, opts);
  } catch (err) {
    if (err.status !== 400) throw err;
    log(`thinkingConfig rejected (${err.message}); retrying once without it`);
    return await callGemma(apiKey, prompt, model, false, opts);
  }
}

// The page card shows "Still trying..." (not an error) while retries are running.
function showStillTrying(opts) {
  log('Still trying...');
  if (opts.kind !== 'dropdown' && session && session.active) {
    sendToTab(session.tabId, 'status', { text: 'Still trying...' }).catch(() => {});
  }
}

// Calls Gemma with automatic recovery. After two failures on the current model (HTTP 5xx or a network
// error) it switches to the other model for the rest of the session. Waits 1s, 3s, 6s between retries.
// Only when every attempt has failed does the error reach the caller (marked `exhausted`).
async function callGemmaWithRetry(apiKey, prompt, model, opts = {}) {
  let current = (session && session.model) || model; // a switch made earlier in this session sticks
  let failures = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await callOnce(apiKey, prompt, current, opts);
    } catch (err) {
      if (!isRetryable(err)) throw err;
      failures++;
      if (attempt >= BACKOFF_MS.length) {
        err.exhausted = true;
        throw err;
      }
      if (failures >= FAILURES_BEFORE_SWITCH) {
        current = MODELS.find((m) => m !== current);
        failures = 0;
        if (session) {
          session.model = current;
          saveSession();
        }
        log(`Switching to ${current}`);
      }
      showStillTrying(opts);
      log(`Retrying (${attempt + 1}/${BACKOFF_MS.length}) in ${BACKOFF_MS[attempt] / 1000}s...`);
      await sleep(BACKOFF_MS[attempt]);
    }
  }
}

// Returns the raw response body text; throws a readable Error on HTTP failure or timeout.
// opts.maxOutputTokens overrides the default limit (the tiny dropdown prompt only needs a few tokens).
// opts.kind is 'dropdown' for hover calls: those may be aborted when a Navigator call starts.
// Navigator calls are never aborted by anything except their own timeout.
async function callGemma(apiKey, prompt, model, thinking, opts = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);
  if (opts.kind === 'dropdown') dropdownControllers.add(controller);
  const started = Date.now();
  const base = opts.maxOutputTokens ? { ...GENERATION_CONFIG, maxOutputTokens: opts.maxOutputTokens } : GENERATION_CONFIG;
  const config = thinking ? { ...base, thinkingConfig: THINKING_CONFIG } : base;
  log(`Calling ${model}...`);
  log(`generationConfig: ${JSON.stringify(config)}`);
  let res;
  let body;
  try {
    res = await fetch(modelUrl(model), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        ...(prompt.system ? { systemInstruction: { parts: [{ text: prompt.system }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
        generationConfig: config,
      }),
      signal: controller.signal,
    });
    body = await res.text();
  } catch (err) {
    // Always log the error name, so aborts and network failures are easy to tell apart.
    log(`Request failed: ${err.name}: ${err.message}`);
    if (err.name === 'AbortError') {
      if (timedOut) {
        const timeout = new Error(`Gemma timed out after ${TIMEOUT_MS / 1000}s`);
        timeout.name = 'TimeoutError';
        timeout.code = 'TIMEOUT';
        throw timeout;
      }
      // Aborted on purpose (a dropdown call yielding to the Navigator): not a network problem.
      const cancelled = new Error('Request cancelled because a more important request started');
      cancelled.name = 'AbortError';
      cancelled.code = 'ABORTED';
      throw cancelled;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    dropdownControllers.delete(controller);
  }
  const elapsedMs = Date.now() - started;
  log(`${model} responded in ${(elapsedMs / 1000).toFixed(1)}s (status ${res.status})`);
  if (res.ok) await recordTiming(model, elapsedMs).catch(() => {});
  if (!res.ok) {
    let message = body.slice(0, 300);
    try {
      message = JSON.parse(body).error.message;
    } catch {}
    const err = new Error(`Gemma error ${res.status}: ${message}`);
    err.name = 'HTTPError';
    err.status = res.status;
    log(`Request failed: HTTPError: status ${res.status}`);
    throw err;
  }
  return body;
}

// In-flight dropdown calls. A Navigator step aborts them: it always has priority.
const dropdownControllers = new Set();

function abortDropdownCalls() {
  if (dropdownControllers.size === 0) return;
  log(`Cancelling ${dropdownControllers.size} dropdown call(s): the Navigator has priority`);
  for (const controller of [...dropdownControllers]) controller.abort();
}

// Turns the raw response body into a decision object, or throws with the first 300 chars.
function parseDecision(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`Response was not JSON: ${body.slice(0, 300)}`);
  }
  const candidate = data && data.candidates && data.candidates[0];
  log(`finishReason: ${candidate ? candidate.finishReason : 'no candidate'}`);
  log(`Response: ${JSON.stringify(data).slice(0, 500)}`);
  // A truncated answer (MAX_TOKENS) is reported with a code so run() can retry with a smaller list.
  const fail = (message) => {
    const err = new Error(message);
    if (candidate && candidate.finishReason === 'MAX_TOKENS') err.code = 'MAX_TOKENS';
    return err;
  };
  const parts = candidate && candidate.content ? candidate.content.parts : null;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw fail(`No candidates/parts in response: ${body.slice(0, 300)}`);
  }
  const textOf = (list) =>
    list
      .filter((p) => p && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim();
  // Prefer non-thought parts; if that is empty, fall back to every part with text.
  const raw = textOf(parts.filter((p) => p && p.thought !== true)) || textOf(parts);
  let decision;
  try {
    decision = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    // Not clean JSON (e.g. the model restated the input): use the LAST {...} block containing "action".
    const blocks = (raw.match(/\{[^{}]*\}/g) || []).filter((b) => b.includes('"action"'));
    try {
      if (blocks.length === 0) throw new Error('no JSON block with "action"');
      decision = JSON.parse(blocks[blocks.length - 1]);
    } catch {
      throw fail(`Could not parse model response: ${raw.slice(0, 300) || '(empty text)'}`);
    }
  }
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw fail(`Unexpected model response: ${raw.slice(0, 300)}`);
  }
  return decision;
}

const MAX_STEPS = 8;
const NAV_WAIT_MS = 1500; // how long to wait for a navigation after a click before rescanning anyway
const SESSION_KEY = 'guidemeSession';

// A key saved in Options wins; otherwise fall back to env.js.
async function loadSettings() {
  const stored = await chrome.storage.local.get(['apiKey', 'model']);
  const apiKey = stored.apiKey || (typeof ENV !== 'undefined' && ENV.GEMINI_API_KEY) || '';
  if (!apiKey) throw new Error('Add your API key in Options');
  const model = MODELS.includes(stored.model) ? stored.model : DEFAULT_MODEL;
  return { apiKey, model };
}

// --- Session: lives here in the panel and is mirrored to chrome.storage.session. ---
// { active, goal, step, history: [{ url, instruction, clickedText }], menuPicks, tabId, targetId, lastInstruction }
let session = null;
let busy = false; // a Navigator run is in progress
let pendingNav = null; // { timer, navigating } after a click, while waiting for the page to change
const dropdownCache = new Map(); // per submenu: item key chosen by Gemma, or null if none fit
const dropdownBusy = new Set();

function saveSession() {
  const area = chrome.storage.session;
  (session ? area.set({ [SESSION_KEY]: session }) : area.remove(SESSION_KEY)).catch(() => {});
}

function updateStopButton() {
  stopButton.disabled = !(session && session.active);
}

function cancelPendingNav() {
  if (pendingNav) clearTimeout(pendingNav.timer);
  pendingNav = null;
}

async function endSession() {
  const tabId = session && session.tabId;
  cancelPendingNav();
  session = null;
  saveSession();
  updateStopButton();
  if (tabId != null) await sendToTab(tabId, 'session', { active: false }).catch(() => {});
}

async function stop() {
  if (!session) return;
  const { tabId } = session;
  await endSession();
  await sendToTab(tabId, 'clear').catch(() => {});
  log('Stopped');
}

// The goal is reached (or we gave up): show the final card and end the session.
async function finishSession(tabId, text) {
  log(`Done: ${text}`);
  await sendToTab(tabId, 'done', { text: `${text}` }).catch(() => {});
  await endSession();
}

// --- One Navigator step: scan the page, ask Gemma (goal + history), highlight the answer. ---
async function run(goal, continuing = false) {
  abortDropdownCalls(); // hover calls never compete with (or abort) this one
  const { apiKey, model } = await loadSettings();

  let tab;
  if (continuing) {
    tab = await chrome.tabs.get(session.tabId);
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab.');
    session = { active: true, goal, step: 1, history: [], menuPicks: [], tabId: tab.id, targetId: null, lastInstruction: '' };
    saveSession();
    updateStopButton();
  }
  const mine = session; // if Stop or a new Start replaces the session, this run quietly ends
  log(`Step ${session.step}`);

  await ensureContentScript(tab.id);
  // Perceived speed: show the pill on the page right away. It is removed when the highlight
  // appears (content.js) or when the run ends.
  await sendToTab(tab.id, 'status', { text: 'GuideMe is reading the page...' });
  const scan = await sendToTab(tab.id, 'scan');
  if (!scan || !Array.isArray(scan.elements)) throw new Error('Page scan returned nothing. Reload the page and try again.');
  const { elements, title, url } = scan;
  lastHandledUrl = url; // the page-load listener must not scan this URL again
  log(`Page scan v${scan.version} found ${elements.length} items`);

  const progressInfo = { step: session.step, history: session.history };
  // The cache key uses the full scan plus how far along the session is.
  const cacheKey = `${url}\n${goal}\n${session.history.length}\n${hashString(formatElements(elements))}`;
  let decision = decisionCache.get(cacheKey);
  if (decision) {
    log('Cached');
  } else {
    log(`Model: ${(session && session.model) || model}`);
    // Ask with the most relevant items; after a timeout or MAX_TOKENS, retry once with a smaller list.
    const ask = async (items) => {
      const prompt = buildPrompt(goal, title, url, formatElements(items), progressInfo);
      log(`Sending ${items.length} items (prompt ${prompt.system.length + prompt.user.length} chars)`);
      return parseDecision(await callGemmaWithRetry(apiKey, prompt, model));
    };
    try {
      decision = await ask(selectItems(goal, elements, TOP_ITEMS, true));
    } catch (err) {
      if (err.code !== 'TIMEOUT' && err.code !== 'MAX_TOKENS') throw err;
      log('Retrying with a smaller list');
      decision = await ask(selectItems(goal, elements, SMALL_LIST, false));
    }
    decisionCache.set(cacheKey, decision);
  }

  if (session !== mine) return; // stopped or restarted while waiting for the model

  // Verify + navigate in one answer: "progress" says how the last click went.
  const progress = ['on_track', 'off_track', 'done'].includes(decision.progress) ? decision.progress : 'on_track';
  log(`Verifier: ${progress.replace('_', ' ')}`);
  if (decision.reason) log(`Navigator: ${decision.reason}`);
  const instruction = decision.instruction || '';

  if (progress === 'done' || decision.action === 'finish') {
    await finishSession(tab.id, instruction || 'You have reached your goal.');
    return;
  }

  // Prefetched dropdown answers: keep only picks that point at real items, at most 5 menus.
  const menuPicks = cleanMenuPicks(decision.menuPicks, elements);
  log(`Prefetched picks for ${menuPicks.length} menus`);

  let targetId = null;
  if (decision.action === 'highlight') {
    const target = elements.find((e) => e.id === String(decision.elementId));
    if (!target) throw new Error(`Model chose unknown element ${decision.elementId}`);
    targetId = target.id;
    await sendToTab(tab.id, 'session', { active: true, targetId: target.id, menuPicks, step: session.step });
    const shown = await sendToTab(tab.id, 'highlight', { id: target.id, instruction, step: session.step });
    // For hidden dropdown items the page decides the wording (e.g. "Under ADMISSIONS, click ...").
    const said = (shown && shown.instruction) || instruction;
    log(`Guide: ${said}`);
    session.lastInstruction = said;
  } else {
    await sendToTab(tab.id, 'clear');
    log(`Help: ${instruction}`);
    session.lastInstruction = instruction;
  }

  // Keep watching (dropdowns, clicks) until the goal is done or the user presses Stop.
  session.targetId = targetId;
  session.menuPicks = menuPicks;
  session.tabId = tab.id;
  saveSession();
  updateStopButton();
  await sendToTab(tab.id, 'session', { active: true, targetId, menuPicks, step: session.step });
}

// menuPicks from the model -> [{ menuId, itemId }] as strings; unknown items and repeated menus are dropped.
function cleanMenuPicks(raw, elements) {
  if (!Array.isArray(raw)) return [];
  const known = new Set(elements.map((e) => e.id));
  const menus = new Set();
  const picks = [];
  for (const pick of raw) {
    if (!pick || typeof pick !== 'object') continue;
    const menuId = String(pick.menuId);
    const itemId = String(pick.itemId);
    if (!known.has(itemId) || menus.has(menuId)) continue;
    menus.add(menuId);
    picks.push({ menuId, itemId });
    if (picks.length >= MAX_MENU_PICKS) break;
  }
  return picks;
}

// Errors that retrying cannot fix (bad key, unsupported page, ...): show them right away.
function isFatal(err) {
  const message = String((err && err.message) || '');
  if (/^Add your API key|^Cannot run on this page|^No active tab/.test(message)) return true;
  const status = err && err.status;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

const STEP_RETRY_DELAYS = [1000, 3000]; // auto-retry a failed step after 1s, then after 3s

// One Navigator step. A failure never ends the session: the step is retried automatically,
// and if it still fails the caller shows a Retry button that resumes from the same step.
async function runWithRetry(goal, continuing) {
  for (let attempt = 0; ; attempt++) {
    try {
      await run(goal, continuing || attempt > 0);
      return;
    } catch (err) {
      const stopped = continuing || attempt > 0 ? !session || !session.active : false;
      if (stopped || err.exhausted || err.code === 'ABORTED' || isFatal(err) || attempt >= STEP_RETRY_DELAYS.length) throw err;
      const delay = STEP_RETRY_DELAYS[attempt];
      log(`Step failed (${err.name}: ${err.message}). Retrying in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }
}

// All attempts failed: keep the session, tell the user, and offer Retry (panel button + page card).
async function showFailure(err) {
  const message = `${(err && err.name) || 'Error'}: ${(err && err.message) || err}`;
  log(`Error: ${message}`);
  retryButton.hidden = false;
  if (session && session.active) {
    await sendToTab(session.tabId, 'error', { text: `Something went wrong. ${message}` }).catch(() => {});
  }
}

// Runs fn with the live "Thinking… 3.2s" line, the disabled Start button and the busy flag.
async function withProgress(fn) {
  busy = true;
  retryButton.hidden = true;
  startButton.disabled = true;
  const began = Date.now();
  const clock = () => new Date(began).toLocaleTimeString();
  const waitLine = log('Thinking… 0.0s');
  const ticker = setInterval(() => {
    waitLine.textContent = `[${clock()}] Thinking… ${((Date.now() - began) / 1000).toFixed(1)}s`;
  }, 100);
  try {
    await fn();
  } catch (err) {
    await showFailure(err);
  } finally {
    clearInterval(ticker);
    waitLine.textContent = `[${clock()}] Finished in ${((Date.now() - began) / 1000).toFixed(1)}s`;
    busy = false;
    startButton.disabled = false;
    // Make sure the status pill never stays on the page (e.g. after an error or a non-highlight answer).
    const tabId = session ? session.tabId : (await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []))[0]?.id;
    if (tabId != null) await sendToTab(tabId, 'hide-status').catch(() => {});
  }
}

async function start() {
  const goal = goalInput.value.trim();
  if (!goal) {
    log('Please enter a goal first.');
    return;
  }
  if (busy) return;
  cancelPendingNav();
  clearTimeout(navDebounce);
  log(`Started: ${goal}`);
  await withProgress(() => runWithRetry(goal, false));
}

// Rescan the page and call the Navigator again with the goal + history.
async function continueSession(reason) {
  if (!session || !session.active || busy) return;
  cancelPendingNav();
  log(reason);
  await withProgress(() => runWithRetry(session.goal, true));
}

// Retry button: resume the current step without restarting (or start over if no session was created yet).
function retry() {
  if (busy) return;
  if (session && session.active) continueSession(`Retrying step ${session.step}`);
  else start();
}

// --- Clicks and navigation. ---
// The page reports the user's click on the highlighted element before it can navigate away.
function onClicked(message) {
  const s = session;
  s.history.push({ url: message.url, instruction: s.lastInstruction, clickedText: message.text });
  s.history = s.history.slice(-MAX_STEPS);
  s.step++;
  saveSession();
  log(`Clicked: ${message.text}`);
  if (s.step > MAX_STEPS) {
    log(`Reached the maximum of ${MAX_STEPS} steps`);
    stop();
    return;
  }
  // Wait for the navigation; if the page stays put (same-page change), continue anyway after a short wait.
  cancelPendingNav();
  pendingNav = {
    navigating: false,
    timer: setTimeout(() => {
      pendingNav = null;
      continueSession('Page did not change, rescanning');
    }, NAV_WAIT_MS),
  };
}

// Page loads: act only on "complete" for the active session tab, once per URL, and wait for the
// page to settle (500ms, debounced) before rescanning. Repeated events for the same load collapse.
const NAV_SETTLE_MS = 500;
let lastHandledUrl = '';
let navDebounce = null;

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!session || !session.active || tabId !== session.tabId) return;
  if (changeInfo.status === 'loading' && pendingNav) {
    // The click started a navigation: stop the same-page timer and wait for the load to finish.
    clearTimeout(pendingNav.timer);
    pendingNav.navigating = true;
  }
  if (changeInfo.status !== 'complete' || !tab || !tab.active) return;

  // A navigation caused by the user's click is always handled; anything else only if the URL is new.
  const fromClick = !!(pendingNav && pendingNav.navigating);
  if (!fromClick && tab.url === lastHandledUrl) return;
  clearTimeout(navDebounce);
  navDebounce = setTimeout(() => {
    if (!session || !session.active || busy) return;
    if (!fromClick && tab.url === lastHandledUrl) return;
    lastHandledUrl = tab.url;
    continueSession('Page loaded, continuing');
  }, NAV_SETTLE_MS);
});

// The page moved the step number: opening a trigger's submenu completes the step (to = from + 1),
// and closing it without a click puts the number back (to < from).
function onStepChange({ from, to }) {
  session.step = to;
  saveSession();
  if (to > from) {
    log(`Step ${from} complete`);
    log(`Step ${to}`);
  } else {
    log(`Step ${to}`);
  }
}

// --- Live dropdown guidance ---
// The best item when it clearly wins on the existing relevance score (score > 0 and above all others).
function localDropdownPick(goal, items) {
  const terms = goalTerms(goal);
  const scores = items.map((item) => scoreItem(item, terms));
  const best = Math.max(...scores);
  if (best <= 0 || scores.filter((score) => score === best).length !== 1) return null;
  return items[scores.indexOf(best)];
}

// Text of the model's reply (non-thought parts, falling back to all parts).
function replyText(body) {
  const parts = (JSON.parse(body).candidates?.[0]?.content?.parts || []).filter((p) => typeof p.text === 'string');
  const visible = parts.filter((p) => p.thought !== true);
  return (visible.length ? visible : parts).map((p) => p.text).join('').trim();
}

// Tiny dedicated prompt: only the goal and the options, answer is one id (or 0 for none).
async function askDropdownPick(apiKey, model, goal, items) {
  const options = items.map((item) => `${item.id} ${clean(item.text, 40)}`).join(', ');
  const prompt = { system: null, user: `Goal: ${goal}. Options: ${options}. Reply with only the id of the best option, or 0.` };
  log(`Asking about ${items.length} dropdown options (prompt ${prompt.user.length} chars)`);
  const body = await callGemmaWithRetry(apiKey, prompt, model, { maxOutputTokens: 20, kind: 'dropdown' });
  const reply = replyText(body);
  log(`Reply: ${reply.slice(0, 40)}`);
  const id = (reply.match(/\d+/) || ['0'])[0]; // first number in the reply
  return id === '0' ? null : items.find((item) => item.id === id) || null;
}

// The page reports a submenu the user just opened (see checkDropdowns in content.js).
async function onDropdownOpened(message) {
  log(`Dropdown opened: ${message.parent}`);
  const s = session;
  if (message.handled) {
    // The page already handled it locally, without any API call.
    if (message.prefetched) log(`Dropdown (prefetched): ${message.item}`);
    else if (!message.skipped) log(`Highlighted in dropdown: ${message.item}`); // the Navigator's own target
    if (!message.skipped) {
      s.lastInstruction = `Under ${message.parent}, click '${message.item}'`;
      saveSession();
    }
    return;
  }
  const items = message.items || [];
  const itemKey = (item) => `${item.tag}|${item.text}`;
  const cacheKey = `${message.url}\n${s.goal}\n${message.parent}\n${hashString(formatElements(items))}`;
  if (dropdownBusy.has(cacheKey)) return;
  dropdownBusy.add(cacheKey);
  try {
    let pickedKey;
    let how = 'gemma';
    if (dropdownCache.has(cacheKey)) {
      log('Cached');
      pickedKey = dropdownCache.get(cacheKey);
    } else {
      // 1. Local match first: if one item clearly beats the rest on the goal, no API call at all.
      const local = localDropdownPick(s.goal, items);
      if (local) {
        pickedKey = itemKey(local);
        how = 'local';
      } else {
        // 2. Ambiguous: ask Gemma for just an id, with a tiny prompt. Never while the Navigator is working.
        if (busy) {
          log('Dropdown skipped: the Navigator is working');
          return;
        }
        const { apiKey, model } = await loadSettings();
        const picked = await askDropdownPick(apiKey, model, s.goal, items);
        pickedKey = picked ? itemKey(picked) : null;
        if (!picked) log('Dropdown: none fit');
      }
      dropdownCache.set(cacheKey, pickedKey);
    }
    // Do nothing if nothing fits, or the user moved on (session ended / changed) meanwhile.
    if (!pickedKey || session !== s) return;
    const item = items.find((i) => itemKey(i) === pickedKey);
    if (!item) return;
    const said = `Under ${message.parent}, click '${item.text}'`;
    const res = await sendToTab(s.tabId, 'live-highlight', { id: item.id, instruction: said });
    if (res && res.ok) {
      log(how === 'local' ? `Dropdown (local): ${item.text}` : `Highlighted in dropdown: ${item.text}`);
      s.lastInstruction = said;
      saveSession();
    }
  } catch (err) {
    // A cancelled hover call is expected (the Navigator took priority); anything else is only logged,
    // it never ends the session.
    if (err.code === 'ABORTED') log('Dropdown call cancelled (AbortError)');
    else log(`Dropdown error (${err.name}): ${(err && err.message) || err}`);
  } finally {
    dropdownBusy.delete(cacheKey);
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!session || !session.active || !sender.tab || sender.tab.id !== session.tabId) return;
  if (message.type === `guideme${CONTENT_VERSION}:retry`) retry();
  else if (message.type === `guideme${CONTENT_VERSION}:dropdown`) onDropdownOpened(message);
  else if (message.type === `guideme${CONTENT_VERSION}:clicked`) onClicked(message);
  else if (message.type === `guideme${CONTENT_VERSION}:step`) onStepChange(message);
  else if (message.type === `guideme${CONTENT_VERSION}:log`) log(message.text);
});

startButton.addEventListener('click', start);
stopButton.addEventListener('click', stop);
retryButton.addEventListener('click', retry);
goalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') start();
});
document.getElementById('options-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Reopening the panel mid-session: restore the goal, step and history.
chrome.storage.session
  .get(SESSION_KEY)
  .then((stored) => {
    const saved = stored[SESSION_KEY];
    if (!saved || !saved.active) return;
    session = saved;
    goalInput.value = saved.goal;
    updateStopButton();
    log(`Restored session: "${saved.goal}" (step ${saved.step})`);
  })
  .catch(() => {});
