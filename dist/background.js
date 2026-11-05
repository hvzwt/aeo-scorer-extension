// Open the side panel when the toolbar icon is clicked. The panel lives outside
// the page, so reloading or navigating the tab does not reset it.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("AEO Scorer: could not set panel behavior", err));
});
