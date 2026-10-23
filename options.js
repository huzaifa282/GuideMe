const keyInput = document.getElementById('key');
const modelSelect = document.getElementById('model');
const saveButton = document.getElementById('save');
const statusEl = document.getElementById('status');
const timingsEl = document.getElementById('timings');

function renderTimings(timings) {
  const rows = Object.entries(timings || {}).map(([model, t]) => {
    const avg = (t.totalMs / t.count / 1000).toFixed(1);
    return `${model}: avg ${avg}s over ${t.count} call(s), last ${(t.lastMs / 1000).toFixed(1)}s`;
  });
  timingsEl.textContent = rows.length ? rows.join('\n') : 'No calls yet.';
}

chrome.storage.local.get(['apiKey', 'model', 'timings']).then(({ apiKey, model, timings }) => {
  if (apiKey) keyInput.value = apiKey;
  if (model) modelSelect.value = model;
  renderTimings(timings);
});

saveButton.addEventListener('click', async () => {
  await chrome.storage.local.set({ apiKey: keyInput.value.trim(), model: modelSelect.value });
  statusEl.textContent = 'Saved.';
});

document.getElementById('reset-timings').addEventListener('click', async () => {
  await chrome.storage.local.remove('timings');
  renderTimings({});
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.timings) renderTimings(changes.timings.newValue);
});
