// Deliberately hostile fixture: blocks the page's main thread forever so that
// page actions never complete. The sandbox must be torn down by its timeout;
// the run must end as TIMEOUT (never PASSED) and the container must be gone.
console.log("[e2e-timeout] content script loaded; entering busy loop");
for (;;) {
  // no-op
}
