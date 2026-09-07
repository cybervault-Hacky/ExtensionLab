// Phase 27 safe fixture service worker — benign only
chrome.runtime.onInstalled.addListener(() => {
  console.log("[ExtensionLab Phase 27] safe fixture installed");
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "SAFE_CHECK") {
    sendResponse({ ok: true, phase: 27, timestamp: Date.now() });
  }
});
