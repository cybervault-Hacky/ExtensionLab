import type { EventHub } from "../events";
import { createChromiumBrowser, createEdgeBrowser } from "./chromium";
import { createFirefoxBrowser } from "./firefox";
import { isSandboxBrowserId, type SandboxBrowser, type SandboxBrowserId } from "./types";

export { ChromiumEngineBrowser, createChromiumBrowser, createEdgeBrowser } from "./chromium";
export { GeckoBrowser, createFirefoxBrowser } from "./firefox";
export type { ElementInspection, SandboxBrowser, SandboxBrowserId } from "./types";

/**
 * Browser runtime factory. The browser id comes from the container's
 * EXTENSIONLAB_BROWSER environment variable, set exclusively by the host
 * Docker driver — never from any request payload.
 */
export function createSandboxBrowser(browserId: string | undefined, events: EventHub): SandboxBrowser {
  const resolved: SandboxBrowserId = isSandboxBrowserId(browserId) ? browserId : "chromium";
  switch (resolved) {
    case "edge":
      return createEdgeBrowser({ events });
    case "firefox":
      return createFirefoxBrowser({ events });
    case "chromium":
    default:
      return createChromiumBrowser({ events });
  }
}
