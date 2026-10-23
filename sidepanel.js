// GuideMe side panel: the orchestrator. It holds the session, makes every Gemma call,
// talks to content.js in the page, and runs the look-ahead scout in the background.

const MODELS = ['gemma-4-26b-a4b-it', 'gemma-4-31b-it']; // keep in sync with options.html
const DEFAULT_MODEL = MODELS[0];
const modelUrl = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
// No responseMimeType: it makes Gemma return HTTP 500. Thinking is turned down instead.
const GENERATION_CONFIG = { temperature: 0, maxOutputTokens: 600 };
const THINKING_CONFIG = { thinkingLevel: 'minimal' };
const TIMEOUT_MS = 30000;
const MAX_LINE_TEXT = 48; // text per element in the prompt
const INFO_LINE_TEXT = 120; // contact details and page text keep more room
const TOP_ITEMS = 60; // items sent to Gemma
const SMALL_LIST = 25; // items sent when retrying after a timeout or MAX_TOKENS
const MAX_SCORED_FIRST = 36; // relevant items that always make the list
const MAX_IN_VIEW = 30; // items currently on screen that always make the list
const MAX_TEXT_SNIPPETS = 6; // page-text lines (only relevant ones)
const MAX_OPTIONS = 15; // <select> option texts per line
const MAX_MENU_PICKS = 5;
const MAX_STEPS = 12;
const LOOKAHEAD_DEPTH = 3; // pages the scout reads ahead of the user
const SCOUT_FETCH_MS = 8000;

const INSTRUCTIONS = `You are GuideMe, a patient guide helping a non-technical user reach a goal on a website, one step at a time. Given the goal and the elements on the page, choose the ONE element the user should click or fill next.
Each line is id|zone|tag|text, optionally followed by:
|>path : where a link goes (a strong hint: |>/admissions/apply-online leads to the online application)
|in:section : the section heading the element sits under
|aria:label  |ph:placeholder  |req (a required form field)
|menu: X (hidden)|mid:N : an item inside the dropdown of menu X; N is the id of X's trigger
|options: ... : the choices of a select
Zones: H=header/nav, M=main, F=footer, D=dialog, I=info. Zone I lines are not clickable: headings, contact details and short page text.
Rules:
- Pick the most direct element toward the goal anywhere on the page (menus, main, footer). Prefer a specific dropdown item over its parent menu.
- If the goal asks for information (phone, email, address, fee, date, requirement) and an I line contains it, highlight that line and put the actual answer in the instruction.
- On a form, guide the next empty field and say what to type or choose; when the fields are done, highlight the submit button. Never ask for passwords.
- If no element fits, use action ask_user and say in the instruction what the user can try.
- Use History (steps already done) to set "progress": on_track (the last step moved toward the goal, or no history yet), off_track (the user is somewhere unhelpful: pick the element that leads back), done (goal reached: action finish, and say what they achieved).
- "menuPicks": for each dropdown menu with an item relevant to the goal, the best item as {"menuId":N,"itemId":id}. At most 5; [] if none.
- Write "instruction" in the language named on the "Reply language" line of the request (English, Urdu script, or Roman Urdu), whatever language the page itself is in. Keep it short and friendly (max 18 words unless it carries an answer) and quote the element's visible text, e.g. Click 'Apply Online'. "reason": English, max 12 words.
Output a single JSON object:
{"action":"highlight"|"finish"|"ask_user","elementId":number|null,"instruction":string,"reason":string,"progress":"on_track"|"off_track"|"done","menuPicks":[{"menuId":number,"itemId":number}]}

Example 1:
Goal: "I want to log in"
Elements:
1|H|a|Home|>/
2|H|button|Sign in
Output: {"action":"highlight","elementId":2,"instruction":"Click 'Sign in' at the top.","reason":"Opens the login form.","progress":"on_track","menuPicks":[]}

Example 2:
Goal: "mujhe admission ke liye apply karna hai"
Elements:
10|H|a|ADMISSIONS|>/admissions
11|H|a|Undergraduate|>/admissions/ug|menu: ADMISSIONS (hidden)|mid:10
12|H|a|Contact|>/contact
Output: {"action":"highlight","elementId":11,"instruction":"ADMISSIONS menu kholein aur 'Undergraduate' par click karein.","reason":"Undergraduate admissions page has the application.","progress":"on_track","menuPicks":[{"menuId":10,"itemId":11}]}

Example 3:
Goal: "مجھے لاگ ان کرنا ہے"
Elements:
1|H|a|Home|>/
2|H|button|Sign in
Output: {"action":"highlight","elementId":2,"instruction":"اوپر 'Sign in' پر کلک کریں۔","reason":"Opens the login form.","progress":"on_track","menuPicks":[]}`;

// Hard language rule appended to every request (see langOf); "instruction" must follow it.
const REPLY_LANGUAGE = {
  en: 'Reply language: English. Write "instruction" in English.',
  ur: 'Reply language: Urdu in Urdu script (اردو). Write "instruction" ONLY in Urdu script, not English or Roman Urdu; keep an element\'s visible text quoted exactly as it appears on the page.',
  roman: 'Reply language: Roman Urdu (Urdu written in English letters). Write "instruction" in Roman Urdu, not English.',
};

const FINAL_LINE =
  'Respond with ONLY the JSON object. Do not restate the goal or elements. No explanation, no markdown.';

const UNDERSTAND_PROMPT = `You help a website guide understand what a user wants. The goal may be in English, Urdu script, or Roman Urdu.
Reply with ONLY a JSON object: {"english":"<the goal as a short English task, max 10 words>","keywords":["<4 to 10 short English words or phrases likely to appear on the website's links or buttons for this task, including synonyms>"]}`;

// --- DOM references ---
const $ = (id) => document.getElementById(id);
const goalInput = $('goal');
const startButton = $('start');
const stopButton = $('stop');
const retryButton = $('retry');
const newGoalButton = $('new-goal');
const logEl = $('log');
const askSection = $('ask');
const sessionSection = $('session');
const goalText = $('goal-text');
const understoodEl = $('understood');
const statusEl = $('status');
const statusText = $('status-text');
const stepsEl = $('steps');

function log(msg) {
  console.log('[GuideMe]', msg);
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  while (logEl.childElementCount > 400) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
  return line;
}

// The one-line status under the goal. kind: busy | idle | ok | error | ahead
function setStatus(text, kind = 'busy') {
  statusText.textContent = text;
  statusEl.dataset.kind = kind;
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
  const s = String(value || '').replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return max ? s.slice(0, max) : s;
}

function normUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return String(url || '');
  }
}

// A link target as a short path: same-site links lose the host.
function shortPath(href, pageUrl) {
  try {
    const u = new URL(href);
    const page = new URL(pageUrl);
    const path = u.pathname + u.search;
    return (u.host === page.host ? path : u.host + path).slice(0, 60);
  } catch {
    return '';
  }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).slice(0, 60);
  } catch {
    return String(url || '').slice(0, 60);
  }
}

const ZONE_LETTER = { 'header/nav': 'H', main: 'M', footer: 'F', modal: 'D' };
const INFO_TAG = { contact: 'contact', heading: 'heading', para: 'text' };

// One compact line per item: id|zone|tag|text, then optional hints (see INSTRUCTIONS).
function formatElements(elements, pageUrl) {
  return elements
    .map((e) => {
      const info = e.tag === 'info';
      const text = clean(e.text || e.ariaLabel || e.placeholder, info ? INFO_LINE_TEXT : MAX_LINE_TEXT);
      const zone = info ? 'I' : ZONE_LETTER[e.zone] || 'M';
      const tag = info ? INFO_TAG[e.kind] || 'info' : e.tag;
      const aria = clean(e.ariaLabel, MAX_LINE_TEXT);
      const placeholder = clean(e.placeholder, MAX_LINE_TEXT);
      let line = `${e.id}|${zone}|${tag}|${text}`;
      const path = e.href && pageUrl ? shortPath(e.href, pageUrl) : '';
      if (path) line += `|>${path}`;
      if (e.context) line += `|in:${clean(e.context, 30)}`;
      if (e.menu) line += `|menu: ${clean(e.menu, 30)} (hidden)${e.menuId ? `|mid:${e.menuId}` : ''}`;
      if (e.options && e.options.length) {
        const shown = e.options.slice(0, MAX_OPTIONS).map((o) => clean(o, 30)).join(', ');
        line += `|options: ${shown}${e.moreOptions ? '...' : ''}`;
      }
      if (aria && aria !== text) line += `|aria:${aria}`;
      if (placeholder && placeholder !== text) line += `|ph:${placeholder}`;
      if (e.required) line += '|req';
      return line;
    })
    .join('\n');
}

// --- Local relevance ranking: narrows hundreds of items down to the ones worth sending. ---
const STOP_WORDS = new Set(
  (
    'a an the to of for and or on in at by is are be i me my we you your it want need how do does can could would should please where what which find get go show take tell about with from this that ' +
    // Roman Urdu filler words
    'mujhe mujhy muje mjhe mujh keliye kay ke ki ka ko liye lie me mein mai se sy h hai hy hain han kaise kese kaisay kya kia krna karna krni karni krne karne chahiye chahta chahti chahiay batao btao bataen bataein dikhao kahan kidhar wala wali aur yeh ye woh wo apna apni mera meri hum ham kar kr ho'
  ).split(' ')
);
// Groups of related terms: a goal word matching any member pulls in the whole group.
const SYNONYM_GROUPS = [
  ['contact', 'phone', 'email', 'contact us', 'call', 'address', 'helpline', 'rabta'],
  ['apply', 'admission', 'admissions', 'application', 'register', 'registration', 'enroll', 'dakhla', 'dakhila', 'apply online'],
  ['scholarship', 'financial aid', 'fee concession', 'need based', 'merit'],
  ['fee', 'fees', 'voucher', 'challan', 'tuition', 'fee structure', 'payment'],
  ['result', 'results', 'marks', 'grade', 'transcript', 'natija'],
  ['login', 'log in', 'sign in', 'signin', 'portal', 'account'],
  ['job', 'jobs', 'career', 'careers', 'vacancy', 'vacancies', 'naukri', 'recruitment'],
  ['download', 'form', 'forms', 'prospectus', 'pdf'],
  ['complaint', 'shikayat', 'feedback', 'grievance'],
  ['date', 'dates', 'schedule', 'deadline', 'last date', 'calendar'],
  ['undergraduate', 'bachelor', 'bs program'],
  ['postgraduate', 'graduate', 'masters', 'mphil', 'phd'],
];
const CONTACT_WORDS = new Set(['contact', 'phone', 'email', 'call', 'address', 'number', 'helpline']);

const normWord = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

function goalTerms(goal, keywords = []) {
  const toWords = (s) =>
    (String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length >= 2 && !STOP_WORDS.has(w)).map(normWord);
  const words = [...new Set([...toWords(goal), ...keywords.flatMap(toWords)])];
  const phrases = keywords.map((k) => String(k).toLowerCase().trim()).filter((k) => k.includes(' '));
  const synonyms = new Set(phrases);
  for (const group of SYNONYM_GROUPS) {
    if (words.some((w) => group.some((member) => normWord(member) === w || member.split(' ').includes(w)))) {
      group.forEach((member) => synonyms.add(member));
    }
  }
  words.forEach((w) => synonyms.delete(w));
  return { words, synonyms: [...synonyms], wantsContact: words.some((w) => CONTACT_WORDS.has(w)) };
}

function scoreItem(item, terms) {
  let path = '';
  try {
    path = item.href ? decodeURIComponent(new URL(item.href).pathname).replace(/[/_\-.]+/g, ' ') : '';
  } catch {}
  const hay = `${item.text} ${item.ariaLabel} ${item.placeholder} ${item.menu || ''} ${item.context || ''} ${path} ${(item.options || []).join(' ')}`.toLowerCase();
  let score = 0;
  for (const w of terms.words) if (hay.includes(w)) score += 2;
  for (const s of terms.synonyms) if (hay.includes(s)) score += 1;
  if (item.tag === 'info' && item.kind === 'contact' && terms.wantsContact) score += 3;
  return score;
}

// The items worth sending, in their original order: the most relevant first, then what is on screen,
// then the rest by score. Page-text lines are only sent when they match the goal.
function selectItems(goal, elements, limit, opts = {}) {
  const terms = goalTerms(goal, opts.keywords);
  const scored = elements
    .map((item, index) => ({ item, index, score: scoreItem(item, terms) }))
    .filter((s) => s.item.kind !== 'para' || s.score > 0);
  const paras = new Set(
    scored.filter((s) => s.item.kind === 'para').sort((a, b) => b.score - a.score).slice(0, MAX_TEXT_SNIPPETS).map((s) => s.index)
  );
  const pool = scored.filter((s) => s.item.kind !== 'para' || paras.has(s.index));
  if (pool.length <= limit) return pool.map((s) => s.item);
  const byScore = pool.slice().sort((a, b) => b.score - a.score || a.index - b.index);
  const keep = new Set();
  for (const s of byScore) {
    if (keep.size >= Math.min(MAX_SCORED_FIRST, limit) || s.score <= 0) break;
    keep.add(s.index);
  }
  if (opts.forceInView) {
    for (const s of pool) {
      if (keep.size >= Math.min(limit, MAX_SCORED_FIRST + MAX_IN_VIEW)) break;
      if (s.item.view === 'in view' && s.item.tag !== 'info') keep.add(s.index);
    }
  }
  for (const s of byScore) {
    if (keep.size >= limit) break;
    keep.add(s.index);
  }
  return pool.filter((s) => keep.has(s.index)).map((s) => s.item);
}

// Readable history for the prompt: where each step happened, what we said, what the user did.
function formatHistory(history) {
  return history
    .map((h, i) => {
      const did = h.note ? h.note : `clicked "${clean(h.clickedText, 40)}"`;
      return `${i + 1}. [${shortUrl(h.url)}] ${clean(h.instruction, 80)} -> ${did}`;
    })
    .join('\n');
}

function buildPrompt(goal, title, url, list, progress, understood) {
  const steps =
    progress && progress.history.length
      ? `Step: ${progress.step}\nHistory:\n${formatHistory(progress.history)}\n`
      : '';
  const english = understood && understood.english ? `Goal in English (for understanding only): ${understood.english}\n` : '';
  return {
    system: `${INSTRUCTIONS}\n\n${FINAL_LINE}`,
    user: `Page: ${title} (${url})\nGoal: ${JSON.stringify(goal)}\n${english}${REPLY_LANGUAGE[langOf(goal)]}\n${steps}Elements:\n${list}`,
  };
}

const CONTENT_VERSION = 15; // must match VERSION in content.js

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
const isRateLimited = (err) => err.status === 429;
const isNetworkError = (err) => err.name === 'TypeError' || /Failed to fetch/i.test(err.message);

// Failures worth retrying (and counting toward a model switch): HTTP 5xx, 429 and network errors.
const isRetryable = (err) => isServerError(err) || isRateLimited(err) || isNetworkError(err);

const BACKOFF_MS = [1000, 3000, 6000]; // waits between retries
const FAILURES_BEFORE_SWITCH = 2; // failures on one model before switching to the other

// One attempt. thinkingConfig is only dropped if the API answers 400 (it rejected the config itself).
async function callOnce(apiKey, prompt, model, opts) {
  try {
    return await callGemma(apiKey, prompt, model, true, opts);
  } catch (err) {
    if (err.status !== 400 || !/thinking/i.test(err.message)) throw err;
    log(`thinkingConfig rejected (${err.message}); retrying once without it`);
    return await callGemma(apiKey, prompt, model, false, opts);
  }
}

// The page card shows "Still trying..." (not an error) while retries are running.
function showStillTrying(opts) {
  if (opts.kind) return; // background calls (dropdown, scout, understand) stay quiet
  setStatus('Gemma is busy, trying again...', 'busy');
  if (session && session.active) {
    sendToTab(session.tabId, 'status', { text: t('retrying'), lang: langOf(session.goal) }).catch(() => {});
  }
}

// Calls Gemma with automatic recovery. A 429 switches models at once (each model has its own quota);
// otherwise two failures on one model switch to the other. Waits 1s, 3s, 6s between retries.
// Only when every attempt has failed does the error reach the caller (marked `exhausted`).
async function callGemmaWithRetry(apiKey, prompt, model, opts = {}) {
  let current = (session && session.model) || model; // a switch made earlier in this session sticks
  let failures = 0;
  const maxRetries = Math.min(opts.maxRetries ?? BACKOFF_MS.length, BACKOFF_MS.length);
  for (let attempt = 0; ; attempt++) {
    try {
      return await callOnce(apiKey, prompt, current, opts);
    } catch (err) {
      if (!isRetryable(err)) throw err;
      failures++;
      if (attempt >= maxRetries) {
        err.exhausted = true;
        throw err;
      }
      if (failures >= FAILURES_BEFORE_SWITCH || isRateLimited(err)) {
        current = MODELS.find((m) => m !== current);
        failures = 0;
        if (session && !opts.kind) {
          session.model = current;
          saveSession();
        }
        log(`Switching to ${current}`);
      }
      showStillTrying(opts);
      const delay = BACKOFF_MS[attempt] * (isRateLimited(err) ? 2 : 1);
      log(`Retrying (${attempt + 1}/${maxRetries}) in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }
}

// In-flight background calls that a Navigator step may cancel (dropdown hovers).
const dropdownControllers = new Set();

function abortDropdownCalls() {
  if (dropdownControllers.size === 0) return;
  log(`Cancelling ${dropdownControllers.size} dropdown call(s): the Navigator has priority`);
  for (const controller of [...dropdownControllers]) controller.abort();
}

// Returns the raw response body text; throws a readable Error on HTTP failure or timeout.
async function callGemma(apiKey, prompt, model, thinking, opts = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs || TIMEOUT_MS);
  if (opts.kind === 'dropdown') dropdownControllers.add(controller);
  const started = Date.now();
  const base = opts.maxOutputTokens ? { ...GENERATION_CONFIG, maxOutputTokens: opts.maxOutputTokens } : GENERATION_CONFIG;
  const config = thinking ? { ...base, thinkingConfig: THINKING_CONFIG } : base;
  const label = opts.kind || 'navigator';
  log(`Calling ${model} (${label}, ${(prompt.system || '').length + prompt.user.length} chars)`);
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
    log(`Request failed: ${err.name}: ${err.message}`);
    if (err.name === 'AbortError') {
      if (timedOut) {
        const timeout = new Error(`Gemma timed out after ${(opts.timeoutMs || TIMEOUT_MS) / 1000}s`);
        timeout.name = 'TimeoutError';
        timeout.code = 'TIMEOUT';
        throw timeout;
      }
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
  log(`${model} (${label}) responded in ${(elapsedMs / 1000).toFixed(1)}s (status ${res.status})`);
  if (res.ok) await recordTiming(model, elapsedMs).catch(() => {});
  if (!res.ok) {
    let message = body.slice(0, 300);
    try {
      message = JSON.parse(body).error.message;
    } catch {}
    const err = new Error(`Gemma error ${res.status}: ${message}`);
    err.name = 'HTTPError';
    err.status = res.status;
    throw err;
  }
  return body;
}

// Every complete {...} block in the text, respecting strings and nesting (menuPicks has nested objects).
function jsonBlocks(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        out.push(text.slice(i, j + 1));
        i = j;
        break;
      }
    }
  }
  return out;
}

// The last JSON object in the text that has `key` (tolerates fences, prose and trailing commas).
function extractJson(raw, key) {
  const stripped = raw.replace(/```(?:json)?/gi, '').trim();
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      try {
        return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        return null;
      }
    }
  };
  const whole = tryParse(stripped);
  if (whole && typeof whole === 'object' && !Array.isArray(whole) && key in whole) return whole;
  const blocks = jsonBlocks(stripped);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const obj = tryParse(blocks[i]);
    if (obj && typeof obj === 'object' && key in obj) return obj;
  }
  return null;
}

// Text of the model's reply (non-thought parts, falling back to all parts) + the candidate.
function replyOf(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`Response was not JSON: ${body.slice(0, 300)}`);
  }
  const candidate = data && data.candidates && data.candidates[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  const textOf = (list) => list.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('').trim();
  return { candidate, text: textOf(parts.filter((p) => p && p.thought !== true)) || textOf(parts) };
}

// Turns the raw response body into a decision object, or throws.
function parseDecision(body) {
  const { candidate, text } = replyOf(body);
  log(`finishReason: ${candidate ? candidate.finishReason : 'no candidate'}`);
  log(`Reply: ${text.slice(0, 400)}`);
  const decision = text && extractJson(text, 'action');
  if (!decision) {
    const err = new Error(`Could not read Gemma's answer: ${text.slice(0, 200) || '(empty)'}`);
    if (candidate && candidate.finishReason === 'MAX_TOKENS') err.code = 'MAX_TOKENS';
    throw err;
  }
  return decision;
}

const NAV_WAIT_MS = 1500; // how long to wait for a navigation after a click before rescanning anyway
const SESSION_KEY = 'guidemeSession';

// A key saved in Options wins; otherwise fall back to env.js.
async function loadSettings() {
  const stored = await chrome.storage.local.get(['apiKey', 'model', 'lookahead']);
  const apiKey = stored.apiKey || (typeof ENV !== 'undefined' && ENV.GEMINI_API_KEY) || '';
  if (!apiKey) throw new Error('Add your API key in Settings');
  const model = MODELS.includes(stored.model) ? stored.model : DEFAULT_MODEL;
  return { apiKey, model, lookahead: stored.lookahead !== false };
}

// --- Session: lives here in the panel and is mirrored to chrome.storage.session. ---
// { active, goal, understood, step, history, steps, menuPicks, tabId, targetId, lastInstruction,
//   pageUrl, pageTitle, nextHref, model }
let session = null;
let busy = false; // a Navigator run is in progress
let pendingNav = null; // { timer, navigating } after a click, while waiting for the page to change
const dropdownCache = new Map(); // per submenu: item key chosen by Gemma, or null if none fit
const dropdownBusy = new Set();

function saveSession() {
  const area = chrome.storage.session;
  (session ? area.set({ [SESSION_KEY]: session }) : area.remove(SESSION_KEY)).catch(() => {});
}

function cancelPendingNav() {
  if (pendingNav) clearTimeout(pendingNav.timer);
  pendingNav = null;
}

// --- Step timeline in the panel ---
// session.steps: [{ n, text, page, state: 'done' | 'current' | 'help' | 'finish', how }]
function setCurrentStep(n, text, how, state = 'current') {
  if (!session) return;
  session.steps = (session.steps || []).filter((s) => s.n < n).map((s) => ({ ...s, state: 'done' }));
  session.steps.push({ n, text, page: session.pageTitle || shortUrl(session.pageUrl), state, how });
  saveSession();
  render();
}

function markStepDone(n) {
  if (!session) return;
  for (const s of session.steps || []) if (s.n === n) s.state = 'done';
  saveSession();
  render();
}

// The upcoming steps the scout has already worked out, starting from where the current step leads.
function previewChain() {
  const out = [];
  if (!session || !session.nextHref) return out;
  let url = session.nextHref;
  const seen = new Set();
  while (url && out.length < LOOKAHEAD_DEPTH) {
    const key = normUrl(url);
    if (seen.has(key)) break;
    seen.add(key);
    const prediction = predictions.get(key);
    if (!prediction) {
      if (scoutInflight.has(key)) out.push({ pending: true });
      break;
    }
    out.push(prediction);
    if (prediction.finish || !prediction.nextHref) break;
    url = prediction.nextHref;
  }
  return out;
}

function stepItem(number, text, meta, state, badge) {
  const li = document.createElement('li');
  li.className = `step ${state}`;
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.textContent = state === 'done' || state === 'finish' ? '✓' : number;
  const body = document.createElement('div');
  body.className = 'body';
  const p = document.createElement('p');
  p.className = 'txt';
  p.textContent = text;
  p.dir = /[֐-ࣿ]/.test(text) ? 'rtl' : 'auto';
  body.appendChild(p);
  if (meta || badge) {
    const m = document.createElement('p');
    m.className = 'meta';
    if (badge) {
      const b = document.createElement('span');
      b.className = `badge ${badge.kind}`;
      b.textContent = badge.text;
      m.appendChild(b);
    }
    if (meta) m.appendChild(document.createTextNode(meta));
    body.appendChild(m);
  }
  li.append(dot, body);
  return li;
}

function render() {
  const active = !!(session && (session.active || (session.steps && session.steps.length)));
  askSection.hidden = active;
  sessionSection.hidden = !active;
  stopButton.hidden = !(session && session.active);
  newGoalButton.hidden = !!(session && session.active);
  if (!session) return;
  goalText.textContent = session.goal;
  goalText.dir = /[֐-ࣿ]/.test(session.goal) ? 'rtl' : 'auto';
  const english = session.understood && session.understood.english;
  understoodEl.hidden = !english || english.toLowerCase() === session.goal.toLowerCase();
  understoodEl.textContent = english ? `Understood: ${english}` : '';

  stepsEl.textContent = '';
  for (const s of session.steps || []) {
    const badge =
      s.how === 'instant' ? { kind: 'instant', text: 'Instant' } : s.how === 'menu' ? { kind: 'menu', text: 'Menu' } : null;
    if (s.state === 'finish') stepsEl.appendChild(stepItem('', s.text, 'Goal reached', 'finish'));
    else stepsEl.appendChild(stepItem(s.n, s.text, s.page, s.state, badge));
  }
  if (session.active) {
    const last = (session.steps || []).slice(-1)[0];
    // Waiting = the user finished a step and the next page is loading (or the first step is coming).
    const waiting = !last || last.state === 'done';
    let n = waiting ? session.step : last.n + 1;
    const chain = previewChain();
    if (waiting && (chain.length === 0 || chain[0].pending)) {
      stepsEl.appendChild(stepItem(n, 'Working out the next step...', '', 'pending'));
      chain.length = 0;
    }
    for (const p of chain) {
      if (p.pending) {
        stepsEl.appendChild(stepItem(n, 'Looking ahead at the next page...', '', 'preview loading'));
        break;
      }
      const text = p.finish ? p.instruction || 'Goal reached' : p.instruction;
      stepsEl.appendChild(stepItem(n, text, p.title, 'preview', { kind: 'ahead', text: 'Up next' }));
      n++;
      if (p.finish) break;
    }
  }
}

async function endSession() {
  const tabId = session && session.tabId;
  cancelPendingNav();
  scoutToken = null;
  if (session) {
    session.active = false;
    session.targetId = null;
  }
  saveSession();
  render();
  if (tabId != null) await sendToTab(tabId, 'session', { active: false }).catch(() => {});
}

async function stop() {
  if (!session || !session.active) return;
  const { tabId } = session;
  await endSession();
  await sendToTab(tabId, 'clear').catch(() => {});
  setStatus('Stopped. Start a new goal any time.', 'idle');
  retryButton.hidden = true;
  log('Stopped');
}

function newGoal() {
  if (session && session.active) return;
  session = null;
  saveSession();
  retryButton.hidden = true;
  render();
  goalInput.focus();
  goalInput.select();
}

// The goal is reached (or we gave up): show the final card and end the session.
async function finishSession(tabId, text) {
  log(`Done: ${text}`);
  const n = session.step;
  session.steps = (session.steps || []).filter((s) => s.n < n).map((s) => ({ ...s, state: 'done' }));
  session.steps.push({ n, text, state: 'finish' });
  setStatus('All done!', 'ok');
  await sendToTab(tabId, 'done', { text, lang: langOf(session.goal) }).catch(() => {});
  await endSession();
}

// --- Goal understanding: any language in, English task + keywords out (for ranking and the panel). ---
async function understandGoal(apiKey, model, goal) {
  try {
    const body = await callGemmaWithRetry(
      apiKey,
      { system: UNDERSTAND_PROMPT, user: `Goal: ${JSON.stringify(goal)}` },
      model,
      { kind: 'understand', maxOutputTokens: 200, maxRetries: 1, timeoutMs: 15000 }
    );
    const { text } = replyOf(body);
    const parsed = extractJson(text, 'english');
    if (!parsed) return null;
    const keywords = Array.isArray(parsed.keywords) ? parsed.keywords.map((k) => clean(k, 30)).filter(Boolean).slice(0, 10) : [];
    log(`Understood: ${parsed.english} | keywords: ${keywords.join(', ')}`);
    return { english: clean(parsed.english, 80), keywords };
  } catch (err) {
    log(`Goal understanding skipped (${err.message})`);
    return null;
  }
}

// The user's language, for the few sentences GuideMe writes itself (menu hints).
const ROMAN_URDU = /\b(mujhe|mujhy|muje|keliye|liye|kaise|kese|kidhar|krna|karna|karni|karein|chahiye|chahta|chahti|kya|kahan|batao|dikhao|hai|hain|hy|mein|ka|ki|ke|ko|se|par|nahi|dakhla|hona|wala|wali|apna|meri|mera)\b/gi;
function langOf(goal) {
  if (/[\u0600-\u06ff]/.test(goal)) return 'ur';
  // Short words like "ka" or "se" also occur in English, so two hits are needed.
  return (goal.match(ROMAN_URDU) || []).length >= 2 ? 'roman' : 'en';
}

// Fixed sentences GuideMe writes itself, in the user's language (en, Roman Urdu, Urdu script).
const TEXT = {
  reached: { en: 'You have reached your goal.', roman: 'Aap apni manzil tak pohanch gaye.', ur: '\u0622\u067e \u0627\u067e\u0646\u06d2 \u0645\u0642\u0635\u062f \u062a\u06a9 \u067e\u06c1\u0646\u0686 \u06af\u0626\u06d2 \u06c1\u06cc\u06ba\u06d4' },
  willReach: { en: 'You will reach your goal.', roman: 'Aap apni manzil tak pohanch jayenge.', ur: '\u0622\u067e \u0627\u067e\u0646\u06d2 \u0645\u0642\u0635\u062f \u062a\u06a9 \u067e\u06c1\u0646\u0686 \u062c\u0627\u0626\u06cc\u06ba \u06af\u06d2\u06d4' },
  noNext: { en: 'I could not find the next step on this page.', roman: 'Is page par agla qadam nahi mila.', ur: '\u0627\u0633 \u0635\u0641\u062d\u06d2 \u067e\u0631 \u0627\u06af\u0644\u0627 \u0645\u0631\u062d\u0644\u06c1 \u0646\u06c1\u06cc\u06ba \u0645\u0644\u0627\u06d4' },
  reading: { en: 'GuideMe is reading the page...', roman: 'GuideMe page parh raha hai...', ur: 'GuideMe \u0635\u0641\u062d\u06c1 \u067e\u0691\u06be \u0631\u06c1\u0627 \u06c1\u06d2...' },
  retrying: { en: 'Still trying...', roman: 'Koshish jari hai...', ur: '\u06a9\u0648\u0634\u0634 \u062c\u0627\u0631\u06cc \u06c1\u06d2...' },
};
const t = (key, goal = session && session.goal) => TEXT[key][goal ? langOf(goal) : 'en'];
function menuWords(menu, item) {
  const lang = session ? langOf(session.goal) : 'en';
  if (lang === 'roman') return `${menu} menu mein '${item}' par click karein`;
  if (lang === 'ur') return `${menu} مینو میں '${item}' پر کلک کریں`;
  return `Under ${menu}, click '${item}'`;
}

const needsUnderstanding = (goal) => /[^\x00-\x7f]/.test(goal) || goalTerms(goal).words.length === 0;

// --- One Navigator step: scan the page, ask Gemma (goal + history), highlight the answer. ---
async function run(goal, continuing = false) {
  abortDropdownCalls(); // hover calls never compete with this one
  const { apiKey, model, lookahead } = await loadSettings();

  let tab;
  if (continuing) {
    tab = await chrome.tabs.get(session.tabId);
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab.');
    predictions.clear();
    session = {
      active: true,
      goal,
      understood: null,
      step: 1,
      history: [],
      steps: [],
      menuPicks: [],
      tabId: tab.id,
      targetId: null,
      lastInstruction: '',
      pageUrl: tab.url,
      pageTitle: tab.title,
      nextHref: null,
    };
    saveSession();
    render();
    // Goal understanding runs alongside the first step; for Urdu script (no English words to rank by)
    // the first step waits for it.
    const understanding = understandGoal(apiKey, model, goal).then((u) => {
      if (u && session && session.goal === goal) {
        session.understood = u;
        saveSession();
        render();
      }
      return u;
    });
    if (needsUnderstanding(goal)) {
      setStatus('Understanding your goal...');
      await understanding;
    }
  }
  const mine = session; // if Stop or a new Start replaces the session, this run quietly ends
  const prevUrl = session.pageUrl;
  log(`Step ${session.step}`);

  setStatus('Reading the page...');
  await ensureContentScript(tab.id);
  await sendToTab(tab.id, 'status', { text: t('reading', goal), lang: langOf(goal) });
  const scan = await sendToTab(tab.id, 'scan');
  if (!scan || !Array.isArray(scan.elements)) throw new Error('Page scan returned nothing. Reload the page and try again.');
  const { elements, title, url } = scan;
  lastHandledUrl = url; // the page-load listener must not scan this URL again
  session.pageUrl = url;
  session.pageTitle = title;
  log(`Page scan v${scan.version} found ${elements.length} items`);

  const keywords = (session.understood && session.understood.keywords) || [];
  const progressInfo = { step: session.step, history: session.history };
  let decision = null;
  let how = 'gemma';

  // 1. The scout may already have worked this page out (look-ahead): use it instantly.
  if (continuing && normUrl(url) !== normUrl(prevUrl)) {
    let prediction = predictions.get(normUrl(url));
    if (!prediction && scoutInflight.has(normUrl(url))) {
      setStatus('Finishing the look-ahead for this page...');
      // Never wait long for it: after 12s, ask Gemma directly instead.
      prediction = await Promise.race([scoutInflight.get(normUrl(url)), sleep(12000).then(() => null)]);
    }
    decision = prediction ? applyPrediction(prediction, elements) : null;
    if (decision) {
      how = 'instant';
      log('Using the look-ahead answer for this page (no wait)');
    }
  }

  // 2. Otherwise ask Gemma now.
  const cacheKey = `${url}\n${goal}\n${langOf(goal)}\n${session.history.length}\n${hashString(formatElements(elements, url))}`;
  if (!decision && decisionCache.has(cacheKey)) {
    decision = decisionCache.get(cacheKey);
    log('Cached');
  }
  if (!decision) {
    setStatus('Gemma is choosing the next step...');
    log(`Model: ${session.model || model}`);
    const ask = async (items) => {
      const prompt = buildPrompt(goal, title, url, formatElements(items, url), progressInfo, session.understood);
      log(`Sending ${items.length} of ${elements.length} items`);
      return parseDecision(await callGemmaWithRetry(apiKey, prompt, model));
    };
    try {
      decision = await ask(selectItems(goal, elements, TOP_ITEMS, { keywords, forceInView: true }));
    } catch (err) {
      if (err.code !== 'TIMEOUT' && err.code !== 'MAX_TOKENS') throw err;
      log('Retrying with a smaller list');
      decision = await ask(selectItems(goal, elements, SMALL_LIST, { keywords }));
    }
    decisionCache.set(cacheKey, decision);
  }

  if (session !== mine || !session.active) return; // stopped or restarted while waiting for the model

  const progress = ['on_track', 'off_track', 'done'].includes(decision.progress) ? decision.progress : 'on_track';
  log(`Progress: ${progress.replace('_', ' ')}${decision.reason ? ` | ${decision.reason}` : ''}`);
  const instruction = clean(decision.instruction, 400) || '';

  if (progress === 'done' || decision.action === 'finish') {
    await finishSession(tab.id, instruction || t('reached', goal));
    return;
  }

  const menuPicks = cleanMenuPicks(decision.menuPicks, elements);
  log(`Prefetched picks for ${menuPicks.length} menus`);

  let targetId = null;
  session.nextHref = null;
  if (decision.action === 'highlight' && decision.elementId != null) {
    const target = elements.find((e) => e.id === String(decision.elementId));
    if (!target) throw new Error(`Gemma chose element ${decision.elementId}, which is not on the page`);
    targetId = target.id;
    session.targetText = target.text;
    await sendToTab(tab.id, 'session', { active: true, targetId: target.id, menuPicks, step: session.step, lang: langOf(goal) });
    const nextHrefNow = nextHrefOf(target, menuPicks, elements, url);
    const known = nextHrefNow && predictions.get(normUrl(nextHrefNow));
    log(`Next page: ${nextHrefNow ? shortUrl(nextHrefNow) : "none"}${known ? " (already looked ahead)" : ""}`);
    const shown = await sendToTab(tab.id, 'highlight', { id: target.id, instruction, step: session.step, next: known ? nextText(known) : '' });
    // For hidden dropdown items the page decides the wording (e.g. "Under ADMISSIONS, click ...").
    const said = (shown && shown.instruction) || instruction;
    log(`Guide: ${said}`);
    session.lastInstruction = said;
    session.nextHref = nextHrefNow;
    setCurrentStep(session.step, said, how);
    setStatus(progress === 'off_track' ? 'Let’s get you back on track. Follow the highlight.' : 'Follow the highlight on the page.', 'ok');
  } else {
    await sendToTab(tab.id, 'clear');
    log(`Help: ${instruction}`);
    session.lastInstruction = instruction;
    setCurrentStep(session.step, instruction || t('noNext', goal), how, 'help');
    setStatus('GuideMe needs your help on this page.', 'idle');
  }

  session.targetId = targetId;
  session.menuPicks = menuPicks;
  session.tabId = tab.id;
  saveSession();
  render();
  await sendToTab(tab.id, 'session', { active: true, targetId, menuPicks, step: session.step, lang: langOf(goal) });

  // 3. While the user reads this step, read ahead.
  if (lookahead && session.nextHref) scoutAhead(session, apiKey, model);
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

// --- Look-ahead scout ---
// After each step, the scout fetches the page the highlighted link leads to, extracts its elements
// from the HTML, and asks Gemma for the step there, up to LOOKAHEAD_DEPTH pages ahead. When the user
// arrives, run() uses the stored answer instantly. Pages are fetched without cookies, and links that
// could change something (log out, delete, ...) are never followed.
const predictions = new Map(); // normUrl -> prediction
const scoutInflight = new Map(); // normUrl -> Promise<prediction | null>
let scoutToken = null;
const UNSAFE_LINK = /log-?out|sign-?out|delete|remove|unsubscribe|cancel|\.(pdf|docx?|xlsx?|zip|rar|jpe?g|png)(\?|$)/i;

function followable(href, pageUrl) {
  if (!href || !/^https?:/i.test(href) || UNSAFE_LINK.test(href)) return false;
  return normUrl(href) !== normUrl(pageUrl);
}

// One line for the page card: what the user will do on the next page.
function nextText(prediction) {
  return prediction.finish ? prediction.instruction || t('willReach') : prediction.instruction;
}

// Where the current step leads: the target link, or the item picked inside the menu the target opens.
function nextHrefOf(target, menuPicks, elements, pageUrl) {
  if (target && followable(target.href, pageUrl) && !UNSAFE_LINK.test(target.text)) return target.href;
  const pick = target && menuPicks.find((p) => p.menuId === target.id);
  const item = pick && elements.find((e) => e.id === pick.itemId);
  if (item && followable(item.href, pageUrl) && !UNSAFE_LINK.test(item.text)) return item.href;
  return null;
}

async function scoutAhead(s, apiKey, model) {
  const token = {};
  scoutToken = token;
  let url = s.nextHref;
  let history = s.history.concat({ url: s.pageUrl, instruction: s.lastInstruction, clickedText: s.targetText || '' });
  for (let depth = 0; depth < LOOKAHEAD_DEPTH && url; depth++) {
    if (session !== s || !s.active || scoutToken !== token) return;
    if (s.step + depth >= MAX_STEPS) return;
    const key = normUrl(url);
    let prediction = predictions.get(key);
    if (!prediction) {
      let pending = scoutInflight.get(key);
      if (!pending) {
        const step = s.step + depth + 1;
        pending = predictPage(s, apiKey, model, url, history, step).catch((err) => {
          log(`Look-ahead stopped (${err.message})`);
          return null;
        });
        scoutInflight.set(key, pending);
        pending.then((p) => {
          scoutInflight.delete(key);
          if (p) {
            predictions.set(key, p);
            predictions.set(normUrl(p.url), p);
          }
          render();
        });
      }
      render();
      if (!busy) setStatus('Follow the highlight. Looking ahead at the next page...', 'ahead');
      prediction = await pending;
      if (!busy && session === s && s.active) setStatus('Follow the highlight on the page.', 'ok');
      // The first page ahead is what the user does next: show it on the page card too.
      if (prediction && depth === 0 && session === s && s.active && !busy) {
        sendToTab(s.tabId, 'next', { text: nextText(prediction) }).catch(() => {});
      }
    }
    if (!prediction || prediction.finish || !prediction.nextHref) return;
    history = history.concat({ url: prediction.url, instruction: prediction.instruction, clickedText: prediction.target ? prediction.target.text : '' });
    url = prediction.nextHref;
  }
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCOUT_FETCH_MS);
  try {
    const res = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!/html/i.test(res.headers.get('content-type') || '')) throw new Error('not an HTML page');
    const html = (await res.text()).slice(0, 3000000);
    return { doc: new DOMParser().parseFromString(html, 'text/html'), url: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

const SCOUT_SELECTOR = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=menuitem]';
const PHONE_RE = /(?:\+?\d[\d\s().-]{5,}\d)/;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

// A page we have not rendered: elements straight from its HTML (no layout, so no visibility checks).
// Dropdown items are recognised by nested lists: an item in a sub-list belongs to the parent list item.
function extractFromDoc(doc, pageUrl) {
  const base = doc.querySelector('base[href]') ? new URL(doc.querySelector('base[href]').getAttribute('href'), pageUrl).href : pageUrl;
  const textOf = (el) => clean(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('value') || '', 50);
  // Closed dropdowns are often hidden, so hidden things inside navigation are kept.
  const hiddenNode = (el) =>
    el.closest('template, noscript, script, style') ||
    (!el.closest('header, nav, [role=navigation], [role=banner]') && el.closest('[hidden], [aria-hidden=true]'));
  const zoneOf = (el) =>
    el.closest('header, nav, [role=navigation], [role=banner]') ? 'header/nav' : el.closest('footer, [role=contentinfo]') ? 'footer' : 'main';
  const elements = [];
  const idOf = new Map();
  const seen = new Set();
  for (const el of doc.querySelectorAll(SCOUT_SELECTOR)) {
    if (elements.length >= 400) break;
    if (hiddenNode(el) || el.matches('input[type=hidden]')) continue;
    const tag = el.tagName.toLowerCase();
    let text = textOf(el);
    if ((tag === 'input' && !/^(submit|button|reset)$/i.test(el.type)) || tag === 'textarea' || tag === 'select') {
      const id = el.getAttribute('id');
      const label = (id && doc.querySelector(`label[for="${CSS.escape(id)}"]`)) || el.closest('label');
      text = clean((label && label.textContent) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '', 50);
    }
    let href = '';
    const raw = el.getAttribute('href');
    if (raw && !raw.startsWith('#') && !/^javascript:/i.test(raw)) {
      try {
        href = new URL(raw, base).href;
      } catch {}
    }
    if (!text) continue;
    const key = `${tag}|${text.toLowerCase()}|${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = `s${elements.length + 1}`;
    idOf.set(el, id);
    const item = { id, tag, text, ariaLabel: '', placeholder: el.getAttribute('placeholder') || '', zone: zoneOf(el), view: 'unknown', menu: '', menuId: '', options: [], href, context: '', el };
    if (tag === 'select') item.options = [...el.querySelectorAll('option')].slice(0, MAX_OPTIONS + 1).map((o) => clean(o.textContent, 30)).filter(Boolean);
    elements.push(item);
  }
  // Dropdown structure from nested lists.
  for (const item of elements) {
    const list = item.el.closest('ul, ol');
    const parentLi = list && list.parentElement && list.parentElement.closest('li');
    if (!parentLi) continue;
    const trigger = [...parentLi.querySelectorAll(SCOUT_SELECTOR)].find((t) => !list.contains(t));
    if (!trigger || trigger === item.el) continue;
    item.menu = textOf(trigger).slice(0, 30);
    item.menuId = idOf.get(trigger) || '';
  }
  // Info: headings, contact details and short text blocks.
  let n = 0;
  const infoSeen = new Set();
  const addInfo = (el, text, kind) => {
    const t = clean(text, kind === 'para' ? 160 : 80);
    if (!t || infoSeen.has(t.toLowerCase()) || hiddenNode(el)) return;
    infoSeen.add(t.toLowerCase());
    elements.push({ id: `i${++n}`, tag: 'info', kind, text: t, ariaLabel: '', placeholder: '', zone: zoneOf(el), view: 'unknown', menu: '', options: [], href: '', context: '' });
  };
  doc.querySelectorAll('h1, h2, h3').forEach((h) => n < 40 && addInfo(h, h.textContent, 'heading'));
  for (const block of doc.querySelectorAll('p, li, td, dd, address')) {
    if (n >= 160) break;
    if (block.querySelector('p, li, table, a, button')) continue;
    const text = clean(block.textContent);
    if (text.length < 20 || text.length > 400) continue;
    const contact = PHONE_RE.test(text) || EMAIL_RE.test(text);
    addInfo(block, text, contact ? 'contact' : 'para');
  }
  for (const item of elements) delete item.el;
  return elements;
}

async function predictPage(s, apiKey, model, url, history, step) {
  log(`Look-ahead: reading ${shortUrl(url)}`);
  const page = await fetchPage(url);
  const elements = extractFromDoc(page.doc, page.url);
  const title = clean(page.doc.title, 80) || shortUrl(page.url);
  if (elements.filter((e) => e.tag !== 'info').length < 3) throw new Error('the page builds itself with JavaScript');
  const keywords = (s.understood && s.understood.keywords) || [];
  const items = selectItems(s.goal, elements, TOP_ITEMS, { keywords });
  const prompt = buildPrompt(s.goal, title, page.url, formatElements(items, page.url), { step, history }, s.understood);
  const decision = parseDecision(await callGemmaWithRetry(apiKey, prompt, model, { kind: 'scout', maxRetries: 1 }));
  const finish = decision.action === 'finish' || decision.progress === 'done';
  const target = elements.find((e) => e.id === String(decision.elementId)) || null;
  const picks = cleanMenuPicks(decision.menuPicks, elements).map((p) => {
    const trigger = elements.find((e) => e.id === p.menuId);
    const item = elements.find((e) => e.id === p.itemId);
    return { menuText: trigger ? trigger.text : '', itemText: item.text, itemHref: item.href };
  });
  const prediction = {
    url: page.url,
    title,
    finish,
    action: finish ? 'finish' : decision.action,
    instruction: clean(decision.instruction, 400),
    target: target ? { text: target.text, href: target.href, tag: target.tag, menu: target.menu } : null,
    menuPicks: picks,
    nextHref: finish || !target ? null : nextHrefOf(target, cleanMenuPicks(decision.menuPicks, elements), elements, page.url),
  };
  log(`Look-ahead for ${shortUrl(page.url)}: ${finish ? 'goal reached' : prediction.instruction}`);
  return prediction;
}

// Turns a stored prediction into a decision for the live page, matching elements by link and text.
// Returns null when the live page does not contain the predicted element (then Gemma is asked).
function applyPrediction(prediction, elements) {
  if (prediction.finish) return { action: 'finish', progress: 'done', instruction: prediction.instruction, menuPicks: [] };
  if (!prediction.target || prediction.action !== 'highlight') return null;
  const t = prediction.target;
  const sameText = (e, text) => e.text && text && e.text.toLowerCase() === text.toLowerCase();
  const candidates = elements.filter((e) => e.tag !== 'info');
  let live = null;
  if (t.href) {
    const byHref = candidates.filter((e) => e.href && normUrl(e.href) === normUrl(t.href));
    live = byHref.find((e) => sameText(e, t.text)) || byHref[0] || null;
  }
  if (!live) live = candidates.find((e) => sameText(e, t.text) && (!t.menu || e.menu));
  if (!live) return null;
  const menuPicks = [];
  for (const p of prediction.menuPicks) {
    const trigger = candidates.find((e) => !e.menu && sameText(e, p.menuText));
    const item = candidates.find((e) => e.menu && ((p.itemHref && e.href && normUrl(e.href) === normUrl(p.itemHref)) || sameText(e, p.itemText)));
    if (item) menuPicks.push({ menuId: item.menuId || (trigger && trigger.id) || '', itemId: item.id });
  }
  return { action: 'highlight', elementId: live.id, instruction: prediction.instruction, reason: 'Prepared in advance by the look-ahead', progress: 'on_track', menuPicks };
}

// Errors that retrying cannot fix (bad key, unsupported page, ...): show them right away.
function isFatal(err) {
  const message = String((err && err.message) || '');
  if (/^Add your API key|^Cannot run on this page|^No active tab/.test(message)) return true;
  const status = err && err.status;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

// What the user sees when a step fails. The technical message stays in the activity log.
function friendlyError(err) {
  const message = String((err && err.message) || err);
  if (/^Add your API key/.test(message)) return 'Add your Gemini API key in Settings first.';
  if (/^Cannot run on this page/.test(message)) return 'GuideMe cannot work on this page. Try a regular website.';
  if (err && err.status === 429) return 'Gemma’s free quota is busy. Wait a few seconds, then press Retry.';
  if (err && (err.status === 400 || err.status === 403) && /key/i.test(message)) return 'Your API key was rejected. Check it in Settings.';
  if (err && (isServerError(err) || isNetworkError(err) || err.code === 'TIMEOUT')) return 'Gemma’s free server is overloaded right now. Press Retry.';
  return `Something went wrong: ${message.slice(0, 160)}`;
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
  log(`Error: ${(err && err.name) || 'Error'}: ${(err && err.message) || err}`);
  const text = friendlyError(err);
  setStatus(text, 'error');
  retryButton.hidden = false;
  if (session && session.active) {
    await sendToTab(session.tabId, 'error', { text }).catch(() => {});
  } else {
    askSection.hidden = false;
  }
}

// Runs fn with the busy flag, the disabled Start button and a live timer in the log.
async function withProgress(fn) {
  busy = true;
  retryButton.hidden = true;
  startButton.disabled = true;
  statusEl.classList.add('working');
  const began = Date.now();
  try {
    await fn();
  } catch (err) {
    await showFailure(err);
  } finally {
    log(`Step finished in ${((Date.now() - began) / 1000).toFixed(1)}s`);
    busy = false;
    startButton.disabled = false;
    statusEl.classList.remove('working');
    const tabId = session ? session.tabId : (await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []))[0]?.id;
    if (tabId != null) await sendToTab(tabId, 'hide-status').catch(() => {});
  }
}

async function start() {
  const goal = goalInput.value.trim();
  if (!goal) {
    goalInput.focus();
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
  markStepDone(s.step);
  s.step++;
  saveSession();
  log(`Clicked: ${message.text}`);
  setStatus('Nice! Waiting for the next page...');
  render();
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
    if (!fromClick) {
      // The user went somewhere on their own: remember it so Gemma can judge whether that helped.
      session.history.push({ url: session.pageUrl, instruction: session.lastInstruction, note: `user went to another page: "${clean(tab.title, 60)}"` });
      session.history = session.history.slice(-MAX_STEPS);
    }
    lastHandledUrl = tab.url;
    continueSession('Page loaded, continuing');
  }, NAV_SETTLE_MS);
});

// The page moved the step number: opening a trigger's submenu completes the step (to = from + 1),
// and closing it without a click puts the number back (to < from).
function onStepChange({ from, to }) {
  session.step = to;
  if (to > from) {
    log(`Step ${from} complete (menu opened)`);
    setCurrentStep(to, 'Choose the highlighted option in the menu', 'menu');
  } else {
    log(`Back to step ${to} (menu closed)`);
    session.steps = (session.steps || []).filter((s) => s.n <= to);
    const current = session.steps.find((s) => s.n === to);
    if (current) current.state = 'current';
    saveSession();
    render();
  }
}

// --- Live dropdown guidance ---
// The best item when it clearly wins on the existing relevance score (score > 0 and above all others).
function localDropdownPick(goal, items) {
  const terms = goalTerms(goal, (session && session.understood && session.understood.keywords) || []);
  const scores = items.map((item) => scoreItem(item, terms));
  const best = Math.max(...scores);
  if (best <= 0 || scores.filter((score) => score === best).length !== 1) return null;
  return items[scores.indexOf(best)];
}

// Tiny dedicated prompt: only the goal and the options, answer is one id (or 0 for none).
async function askDropdownPick(apiKey, model, goal, items) {
  const options = items.map((item) => `${item.id} ${clean(item.text, 40)}`).join(', ');
  const prompt = { system: null, user: `Goal: ${goal}. Options: ${options}. Reply with only the id of the best option, or 0.` };
  log(`Asking about ${items.length} dropdown options`);
  const body = await callGemmaWithRetry(apiKey, prompt, model, { maxOutputTokens: 20, kind: 'dropdown' });
  const reply = replyOf(body).text;
  log(`Reply: ${reply.slice(0, 40)}`);
  const id = (reply.match(/\d+/) || ['0'])[0]; // first number in the reply
  return id === '0' ? null : items.find((item) => item.id === id) || null;
}

// The current step's text in the timeline follows what the page actually shows.
function updateCurrentText(text) {
  const current = session && (session.steps || []).find((s) => s.n === session.step);
  if (current) {
    current.text = text;
    saveSession();
    render();
  }
}

// The page reports a submenu the user just opened (see checkDropdowns in content.js).
async function onDropdownOpened(message) {
  log(`Dropdown opened: ${message.parent}`);
  const s = session;
  if (message.handled) {
    if (message.prefetched) log(`Dropdown (prefetched): ${message.item}`);
    else if (!message.skipped) log(`Highlighted in dropdown: ${message.item}`);
    if (!message.skipped) {
      s.lastInstruction = message.instruction || menuWords(message.parent, message.item);
      updateCurrentText(s.lastInstruction);
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
    if (!pickedKey || session !== s) return;
    const item = items.find((i) => itemKey(i) === pickedKey);
    if (!item) return;
    const said = menuWords(message.parent, item.text);
    const res = await sendToTab(s.tabId, 'live-highlight', { id: item.id, instruction: said });
    if (res && res.ok) {
      log(how === 'local' ? `Dropdown (local): ${item.text}` : `Highlighted in dropdown: ${item.text}`);
      s.lastInstruction = said;
      updateCurrentText(said);
    }
  } catch (err) {
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
newGoalButton.addEventListener('click', newGoal);
goalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    start();
  }
});
document.querySelectorAll('.chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    goalInput.value = chip.dataset.goal || chip.textContent;
    goalInput.focus();
  })
);
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

// First run: point at Settings when there is no API key yet.
chrome.storage.local.get('apiKey').then(({ apiKey }) => {
  const hasEnvKey = typeof ENV !== 'undefined' && ENV.GEMINI_API_KEY;
  $('key-hint').hidden = !!(apiKey || hasEnvKey);
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.apiKey) $('key-hint').hidden = !!changes.apiKey.newValue;
});

// Reopening the panel mid-session: restore the goal, step and timeline.
chrome.storage.session
  .get(SESSION_KEY)
  .then((stored) => {
    const saved = stored[SESSION_KEY];
    if (!saved) return;
    session = saved;
    goalInput.value = saved.goal;
    if (saved.active) {
      setStatus('Follow the highlight on the page.', 'ok');
      log(`Restored session: "${saved.goal}" (step ${saved.step})`);
    } else {
      setStatus('Finished.', 'ok');
    }
    render();
  })
  .catch(() => {});

render();
