// Open the side panel when the toolbar icon is clicked.
// All orchestration lives in sidepanel.js.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
