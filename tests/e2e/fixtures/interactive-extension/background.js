// Service worker: emits a deterministic console event on startup so the
// interactive session can observe genuine extension-load evidence (a real
// background context) through the runner's event stream. No network access.
console.log("[interactive-fixture] service worker started");

chrome.runtime.onInstalled.addListener(function () {
  console.log("[interactive-fixture] installed");
});
