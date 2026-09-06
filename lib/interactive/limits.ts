import "server-only";
import { getConfig } from "@/lib/config/env";
import type { BrowserInputAction, InputTarget, PointerButton } from "@/types/interactive";

/**
 * Phase 11 input-model validation.
 *
 * Every client-supplied browser command is checked here against fixed,
 * deployment-configured bounds before it is forwarded to the isolated runner.
 * The runner validates again inside the container: two independent allowlists
 * with no generic passthrough between them.
 */

/** Keys the key_press action accepts. Names map to virtual key codes in the runner. */
export const ALLOWED_KEYS: readonly string[] = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  ...Array.from({ length: 10 }, (_, i) => String(i)),
];

export const MAX_TYPE_TEXT_LENGTH = 2000;
export const MAX_INPUT_PAYLOAD_BYTES = 8 * 1024;
export const MAX_SCROLL_DELTA = 3000;
export const MAX_URL_INPUT_LENGTH = 2048;

export function isInputTarget(value: unknown): value is InputTarget {
  return value === "page" || value === "popup";
}

function isPointerButton(value: unknown): value is PointerButton {
  return value === "left" || value === "right";
}

export interface ViewportBounds {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
}

export function viewportBounds(): ViewportBounds {
  const config = getConfig().interactiveBrowser;
  return {
    minWidth: config.viewportMinWidth,
    maxWidth: config.viewportMaxWidth,
    minHeight: config.viewportMinHeight,
    maxHeight: config.viewportMaxHeight,
  };
}

export function validateViewport(
  width: unknown,
  height: unknown,
): { ok: true; width: number; height: number } | { ok: false; reason: string } {
  const bounds = viewportBounds();
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return { ok: false, reason: "Viewport dimensions must be whole numbers." };
  }
  const w = width as number;
  const h = height as number;
  if (w < bounds.minWidth || w > bounds.maxWidth) {
    return { ok: false, reason: `Viewport width must be between ${bounds.minWidth} and ${bounds.maxWidth}.` };
  }
  if (h < bounds.minHeight || h > bounds.maxHeight) {
    return { ok: false, reason: `Viewport height must be between ${bounds.minHeight} and ${bounds.maxHeight}.` };
  }
  return { ok: true, width: w, height: h };
}

/**
 * Validates one input action against the typed schema and the configured
 * bounds. `viewport` is the session's current page size (or popup size when
 * the action targets the popup) so coordinates are always in-range.
 */
export function validateInputAction(
  action: unknown,
  viewport: { width: number; height: number },
): { ok: true; action: BrowserInputAction } | { ok: false; reason: string } {
  if (!action || typeof action !== "object") {
    return { ok: false, reason: "An input action object is required." };
  }
  const raw = action as Record<string, unknown>;
  const allowedFields = new Set(["type", "x", "y", "button", "text", "key", "deltaX", "deltaY", "target"]);
  for (const key of Object.keys(raw)) {
    if (!allowedFields.has(key)) {
      return { ok: false, reason: `Unexpected field "${key}" in the input action.` };
    }
  }
  let target: InputTarget = "page";
  if (raw.target !== undefined) {
    if (!isInputTarget(raw.target)) {
      return { ok: false, reason: "The input target must be \"page\" or \"popup\"." };
    }
    target = raw.target;
  }

  const checkCoords = (x: unknown, y: unknown): { ok: true; x: number; y: number } | { ok: false; reason: string } => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, reason: "Coordinates must be numbers." };
    }
    const cx = Math.round(x as number);
    const cy = Math.round(y as number);
    if (cx < 0 || cy < 0 || cx > viewport.width || cy > viewport.height) {
      return {
        ok: false,
        reason: `Coordinates must stay inside the ${viewport.width}×${viewport.height} viewport.`,
      };
    }
    return { ok: true, x: cx, y: cy };
  };

  switch (raw.type) {
    case "pointer_move":
    case "pointer_down":
    case "pointer_up":
    case "click":
    case "double_click": {
      const coords = checkCoords(raw.x, raw.y);
      if (!coords.ok) return coords;
      if (raw.button !== undefined && !isPointerButton(raw.button)) {
        return { ok: false, reason: "Only the left and right mouse buttons are supported." };
      }
      if (raw.target !== undefined && !isInputTarget(raw.target)) {
        return { ok: false, reason: "The input target must be \"page\" or \"popup\"." };
      }
      const base: BrowserInputAction = raw.button === undefined
        ? ({ type: raw.type, x: coords.x, y: coords.y, target } as BrowserInputAction)
        : ({ type: raw.type, x: coords.x, y: coords.y, button: raw.button, target } as BrowserInputAction);
      return { ok: true, action: base };
    }
    case "type_text": {
      if (typeof raw.text !== "string") {
        return { ok: false, reason: "Text is required for typing actions." };
      }
      if (raw.text.length > MAX_TYPE_TEXT_LENGTH) {
        return { ok: false, reason: `Text is limited to ${MAX_TYPE_TEXT_LENGTH} characters per action.` };
      }
      return { ok: true, action: { type: "type_text", text: raw.text, target } };
    }
    case "key_press": {
      if (typeof raw.key !== "string" || !ALLOWED_KEYS.includes(raw.key)) {
        return { ok: false, reason: "This key is not supported." };
      }
      return { ok: true, action: { type: "key_press", key: raw.key, target } };
    }
    case "scroll": {
      const coords = checkCoords(raw.x, raw.y);
      if (!coords.ok) return coords;
      const deltaX = Number(raw.deltaX);
      const deltaY = Number(raw.deltaY);
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
        return { ok: false, reason: "Scroll deltas must be numbers." };
      }
      if (Math.abs(deltaX) > MAX_SCROLL_DELTA || Math.abs(deltaY) > MAX_SCROLL_DELTA) {
        return { ok: false, reason: `Scroll deltas are limited to ±${MAX_SCROLL_DELTA}.` };
      }
      return {
        ok: true,
        action: { type: "scroll", x: coords.x, y: coords.y, deltaX: Math.round(deltaX), deltaY: Math.round(deltaY), target },
      };
    }
    default:
      return { ok: false, reason: "Unsupported input action." };
  }
}

/** Raw request-body size guard for input endpoints. */
export function inputPayloadWithinLimit(payload: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(payload ?? {}), "utf8") <= MAX_INPUT_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}
