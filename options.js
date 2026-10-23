const keyInput = document.getElementById('key');
const saveButton = document.getElementById('save');
const statusEl = document.getElementById('status');

chrome.storage.local.get('apiKey').then(({ apiKey }) => {
  if (apiKey) keyInput.value = apiKey;
});

saveButton.addEventListener('click', async () => {
  await chrome.storage.local.set({ apiKey: keyInput.value.trim() });
  statusEl.textContent = 'Saved.';
});
