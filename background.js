// Open the side panel when the toolbar icon is clicked.
// All orchestration lives in sidepanel.js.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
// Also on browser start (setPanelBehavior is persisted, but this keeps it reliable after updates).
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
