const MODEL = 'gemma-4-26b-a4b-it';
const FALLBACK_MODEL = 'gemma-4-31b-it';
const modelUrl = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
// No responseMimeType: it makes Gemma return HTTP 500. Thinking is turned down instead.
const GENERATION_CONFIG = { temperature: 0, maxOutputTokens: 1024 };
const THINKING_CONFIG = { thinkingLevel: 'minimal' };
const TIMEOUT_MS = 60000;
const RETRIES = 2;
const RETRY_DELAY_MS = 1500;

const INSTRUCTIONS = `You are GuideMe, a patient guide helping a non-technical user complete a goal on a website. Given the user's goal and the list of interactive elements, choose the ONE element the user should click or use next. If the goal is already achieved, use action finish. If no element fits, use action ask_user and explain what to do in the instruction.
Write a short, friendly instruction (max 15 words).
Output a single JSON object with this shape:
{"action":"highlight"|"finish"|"ask_user","elementId":number|null,"instruction":string,"reason":string}

Example:
Goal: "I want to log in"
Elements:
1 | a | Home
2 | button | Sign in
Output: {"action":"highlight","elementId":2,"instruction":"Click 'Sign in' at the top.","reason":"This button opens the login form."}`;

const FINAL_LINE =
  'Respond with ONLY the JSON object. Do not restate the goal or elements. No explanation, no markdown.';

const goalInput = document.getElementById('goal');
const startButton = document.getElementById('start');
const logEl = document.getElementById('log');

function log(msg) {
  console.log('[GuideMe]', msg);
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function clean(value, max) {
  const s = String(value || '').replace(/[|\r\n]+/g, ' ').trim();
  return max ? s.slice(0, max) : s;
}

function formatElements(elements) {
  return elements
    .map((e) => [e.id, e.tag, clean(e.text, 40), clean(e.ariaLabel), clean(e.placeholder)].join(' | '))
    .join('\n');
}

// system = role, rules, example and the "ONLY the JSON object" line; user = just the goal and elements.
function buildPrompt(goal, title, url, list) {
  return {
    system: `${INSTRUCTIONS}\n\n${FINAL_LINE}`,
    user: `Page: ${title} (${url})\nGoal: ${JSON.stringify(goal)}\nElements (id | tag | text | aria-label | placeholder):\n${list}`,
  };
}

const CONTENT_VERSION = 3; // must match VERSION in content.js

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

const isTransient = (err) => err.status === 500 || err.status === 503;

const isNetworkError = (err) => err.name === 'TypeError' || /Failed to fetch/i.test(err.message);

// Retries HTTP 500/503 up to RETRIES times (short delay), and a network error once after 2s.
// A 400/500 while thinkingConfig is present drops thinkingConfig and retries once, right away.
// Every attempt goes through callGemma, which creates its own AbortController.
async function callWithRetry(apiKey, prompt, model) {
  let networkRetried = false;
  let thinking = true;
  for (let attempt = 0; ; ) {
    try {
      return await callGemma(apiKey, prompt, model, thinking);
    } catch (err) {
      if (thinking && (err.status === 400 || err.status === 500)) {
        thinking = false;
        log(`thinkingConfig rejected (${err.message}); retrying once without it`);
      } else if (isNetworkError(err) && !networkRetried) {
        networkRetried = true;
        log('Network error, retrying...');
        await sleep(2000);
      } else if (isTransient(err) && attempt < RETRIES) {
        attempt++;
        log(`Retrying (${attempt}/${RETRIES})...`);
        await sleep(RETRY_DELAY_MS);
      } else {
        throw err;
      }
    }
  }
}

// Primary model first; if it keeps failing with 500/503, one last attempt on the fallback model.
async function callGemmaWithRetry(apiKey, prompt) {
  try {
    return await callWithRetry(apiKey, prompt, MODEL);
  } catch (err) {
    if (!isTransient(err)) throw err;
    log(`Falling back to ${FALLBACK_MODEL}`);
    return await callWithRetry(apiKey, prompt, FALLBACK_MODEL);
  }
}

// Returns the raw response body text; throws a readable Error on HTTP failure or timeout.
async function callGemma(apiKey, prompt, model, thinking) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  const config = thinking ? { ...GENERATION_CONFIG, thinkingConfig: THINKING_CONFIG } : GENERATION_CONFIG;
  log(`Calling ${model}...`);
  log(`generationConfig: ${JSON.stringify(config)}`);
  let res;
  let body;
  try {
    res = await fetch(modelUrl(model), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
        generationConfig: config,
      }),
      signal: controller.signal,
    });
    body = await res.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      log('Gemma timed out');
      throw new Error(`Gemma timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  log(`Gemma responded in ${((Date.now() - started) / 1000).toFixed(1)}s (status ${res.status})`);
  if (!res.ok) {
    let message = body.slice(0, 300);
    try {
      message = JSON.parse(body).error.message;
    } catch {}
    const err = new Error(`Gemma error ${res.status}: ${message}`);
    err.status = res.status;
    throw err;
  }
  return body;
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
  const parts = candidate && candidate.content ? candidate.content.parts : null;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error(`No candidates/parts in response: ${body.slice(0, 300)}`);
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
      throw new Error(`Could not parse model response: ${raw.slice(0, 300) || '(empty text)'}`);
    }
  }
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new Error(`Unexpected model response: ${raw.slice(0, 300)}`);
  }
  return decision;
}

async function run(goal) {
  // A key saved in Options wins; otherwise fall back to env.js.
  const stored = await chrome.storage.local.get('apiKey');
  const apiKey = stored.apiKey || (typeof ENV !== 'undefined' && ENV.GEMINI_API_KEY) || '';
  if (!apiKey) throw new Error('Add your API key in Options');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab.');

  await ensureContentScript(tab.id);
  const scan = await sendToTab(tab.id, 'scan');
  if (!scan || !Array.isArray(scan.elements)) throw new Error('Page scan returned nothing. Reload the page and try again.');
  const { elements, title, url } = scan;
  const prompt = buildPrompt(goal, title, url, formatElements(elements));
  log(`Page scan v${scan.version} found ${elements.length} elements (sending ${elements.length}, prompt ${prompt.system.length + prompt.user.length} chars)`);
  const decision = parseDecision(await callGemmaWithRetry(apiKey, prompt));

  if (decision.reason) log(`Navigator: ${decision.reason}`);
  const instruction = decision.instruction || '';

  if (decision.action === 'highlight') {
    const target = elements.find((e) => e.id === String(decision.elementId));
    if (!target) throw new Error(`Model chose unknown element ${decision.elementId}`);
    await sendToTab(tab.id, 'highlight', { id: target.id, instruction });
    log(`Step: ${instruction}`);
  } else {
    await sendToTab(tab.id, 'clear');
    log(`${decision.action === 'finish' ? 'Done' : 'Help'}: ${instruction}`);
  }
}

async function start() {
  const goal = goalInput.value.trim();
  if (!goal) {
    log('Please enter a goal first.');
    return;
  }
  log(`Started: ${goal}`);
  startButton.disabled = true;
  log('Thinking…');
  try {
    await run(goal);
  } catch (err) {
    log(`Error: ${(err && err.message) || err}`);
  } finally {
    startButton.disabled = false;
  }
}

startButton.addEventListener('click', start);
goalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') start();
});
document.getElementById('options-link').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
