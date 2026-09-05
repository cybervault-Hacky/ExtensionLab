// Service worker: emits a deterministic console event on install/startup and
// answers a ping from the content script. No network access from the worker.
console.log("[e2e-basic] service worker started");

chrome.runtime.onInstalled.addListener(function () {
  console.log("[e2e-basic] installed");
});

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  if (message && message.type === "ping") {
    sendResponse({ type: "pong", at: Date.now() });
  }
  return true;
});
