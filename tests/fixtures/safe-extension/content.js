// Phase 27 safe fixture content script — benign only
console.log("[ExtensionLab Phase 27] safe fixture content script loaded");
const marker = document.createElement("div");
marker.id = "extensionlab-safe-marker";
marker.textContent = "SAFE";
marker.style.position = "fixed";
marker.style.top = "0";
marker.style.left = "0";
marker.style.zIndex = "99999";
marker.style.background = "#00aa00";
marker.style.color = "#fff";
marker.style.padding = "4px";
document.body.appendChild(marker);
