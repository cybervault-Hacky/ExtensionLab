// Content script: logs a deterministic console event, marks the page, and
// performs one safe same-origin request against the sandbox's local test page.
console.log("[e2e-basic] content script loaded");

var marker = document.createElement("div");
marker.id = "extensionlab-e2e-marker";
marker.setAttribute("data-testid", "e2e-marker");
marker.textContent = "e2e content script active";
marker.style.display = "block";
(document.body || document.documentElement).appendChild(marker);

try {
  fetch(location.origin + "/extensionlab-test", { method: "GET", cache: "no-store" })
    .then(function (response) {
      console.log("[e2e-basic] network request completed with status " + response.status);
    })
    .catch(function () {
      console.log("[e2e-basic] network request failed");
    });
} catch (_error) {
  console.log("[e2e-basic] network request unavailable");
}

try {
  chrome.runtime.sendMessage({ type: "ping" }, function (reply) {
    if (reply && reply.type === "pong") console.log("[e2e-basic] service worker replied");
  });
} catch (_error) {
  // Messaging is best-effort in the fixture.
}
