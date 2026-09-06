"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { canvasScale, mapPointerToViewport } from "@/lib/interactive/coordinates";
import type { BrowserInputAction } from "@/types/interactive";

/* eslint-disable @next/next/no-img-element */

/**
 * Dedicated browser viewport component (Phase 12).
 *
 * Responsibilities:
 *  - render the latest PNG frame from the isolated browser at the session's
 *    aspect ratio (responsive, letterboxed, device-pixel-ratio agnostic);
 *  - map pointer events onto the REAL viewport coordinates via the shared
 *    pure mapper (server validation stays authoritative);
 *  - subtle, reduced-motion-aware click feedback;
 *  - keyboard capture with an explicit allowlist (handled keys never escape
 *    to the host application);
 *  - loading / reconnecting / terminal overlays;
 *  - wheel scrolling with 1:1 scale correction and no host-page scroll;
 *  - fullscreen for the canvas area only.
 *
 * It never renders extension HTML — the frame is an image transported from
 * the container, nothing more.
 */

export interface CanvasOverlays {
  live: boolean;
  loading: boolean;
  reconnecting: boolean;
  overlay?: React.ReactNode;
}

const NAMED_KEYS = [
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
];

interface FeedbackMark {
  id: number;
  x: number; // viewport coords, for positioning we convert back to %
  y: number;
  at: number;
}

export function BrowserCanvas({
  frameUrl,
  viewport,
  overlays,
  disabled,
  inspectMode,
  onInput,
  onInspect,
  onPaste,
  canvasRef,
}: {
  frameUrl: string | null;
  viewport: { width: number; height: number };
  overlays: CanvasOverlays;
  disabled: boolean;
  inspectMode: boolean;
  onInput: (action: BrowserInputAction) => void;
  onInspect: (x: number, y: number) => void;
  onPaste?: () => void;
  canvasRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [feedback, setFeedback] = useState<FeedbackMark[]>([]);
  const [focused, setFocused] = useState(false);
  const lastWheelRef = useRef(0);
  const localRef = useRef<HTMLDivElement | null>(null);

  const setRefs = (node: HTMLDivElement | null) => {
    innerRef.current = node;
    localRef.current = node;
    if (canvasRef) canvasRef.current = node;
  };

  // Drop stale click feedback marks (bounded array by construction).
  useEffect(() => {
    if (feedback.length === 0) return;
    const timer = setTimeout(() => setFeedback((marks) => marks.filter((mark) => Date.now() - mark.at < 900)), 1000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const pointFor = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const element = innerRef.current;
      if (!element) return null;
      return mapPointerToViewport({
        clientX,
        clientY,
        rect: element.getBoundingClientRect(),
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      });
    },
    [viewport.width, viewport.height],
  );

  const markFeedback = (x: number, y: number) => {
    setFeedback((marks) => [...marks.slice(-4), { id: Date.now() + Math.random(), x, y, at: Date.now() }]);
  };

  const dispatchPointer = (event: React.MouseEvent, type: "click" | "double_click" | "pointer_down" | "pointer_up") => {
    if (disabled) return;
    const point = pointFor(event.clientX, event.clientY);
    if (!point) return; // outside the canvas: dropped, never clamped
    if (type === "click") markFeedback(point.x, point.y);
    if (inspectMode && type === "click") {
      onInspect(point.x, point.y);
      return;
    }
    onInput({
      type,
      x: point.x,
      y: point.y,
      button: event.button === 2 ? "right" : "left",
      target: "page",
    } as BrowserInputAction);
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    // Never let browser-canvas scrolling scroll the host page.
    event.preventDefault();
    if (disabled || inspectMode) return;
    const now = Date.now();
    if (now - lastWheelRef.current < 100) return;
    lastWheelRef.current = now;
    const point = pointFor(event.clientX, event.clientY);
    if (!point) return;
    const element = innerRef.current;
    const scale = element ? canvasScale(element.getBoundingClientRect(), viewport.width) : 1;
    onInput({
      type: "scroll",
      x: point.x,
      y: point.y,
      deltaX: Math.max(-3000, Math.min(3000, Math.round(event.deltaX * scale))),
      deltaY: Math.max(-3000, Math.min(3000, Math.round(event.deltaY * scale))),
      target: "page",
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    // OS/browser shortcut combinations are never forwarded.
    if (event.metaKey || event.ctrlKey || event.altKey) {
      event.stopPropagation();
      return;
    }
    if (event.key === "v" && event.shiftKey && onPaste) {
      event.preventDefault();
      onPaste();
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      event.stopPropagation();
      onInput({ type: "type_text", text: event.key, target: "page" });
      return;
    }
    if (NAMED_KEYS.includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      onInput({ type: "key_press", key: event.key, target: "page" });
    }
  };

  const toggleFullscreen = async () => {
    const element = innerRef.current?.parentElement ?? null;
    if (!element) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await element.requestFullscreen();
    } catch {
      // Fullscreen may be denied; the workspace stays fully usable.
    }
  };

  const showPlaceholder = !frameUrl || overlays.loading || overlays.reconnecting;

  return (
    <div className="relative bg-[var(--bg)]">
      <div className="mx-auto w-full" style={{ maxWidth: `${viewport.width}px` }}>
        <div
          ref={setRefs}
          role="application"
          aria-label={`Interactive browser viewport, ${viewport.width} by ${viewport.height} pixels${focused ? ", keyboard focus — typed keys go to the test browser" : ""}`}
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          onClick={(event) => dispatchPointer(event, "click")}
          onDoubleClick={(event) => dispatchPointer(event, "double_click")}
          onMouseDown={(event) => dispatchPointer(event, "pointer_down")}
          onMouseUp={(event) => dispatchPointer(event, "pointer_up")}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onContextMenu={(event) => event.preventDefault()}
          style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }}
          className={cn(
            "relative w-full select-none outline-none transition-opacity focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]",
            disabled ? "cursor-not-allowed" : inspectMode ? "cursor-crosshair" : "cursor-default",
          )}
        >
          {frameUrl ? (
            <img
              src={frameUrl}
              alt="Live page inside the isolated ExtensionLab browser"
              draggable={false}
              className={cn("pointer-events-none absolute inset-0 h-full w-full object-fill", showPlaceholder && "opacity-40")}
            />
          ) : null}

          {showPlaceholder || overlays.overlay ? (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--surface)]/60 p-6 text-center">
              {overlays.overlay ?? (
                <p className="text-sm text-[var(--text-secondary)]">
                  {overlays.reconnecting ? "Reconnecting to the browser session…" : "Waiting for the first browser frame…"}
                </p>
              )}
            </div>
          ) : null}

          {/* Click feedback: small, brief pointer indicators (reduced-motion safe). */}
          {feedback.map((mark) => (
            <span
              key={mark.id}
              aria-hidden="true"
              className="pointer-events-none absolute z-10 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--accent)] motion-safe:animate-ping"
              style={{
                left: `${(mark.x / viewport.width) * 100}%`,
                top: `${(mark.y / viewport.height) * 100}%`,
                animationIterationCount: 1,
              }}
            />
          ))}

          {inspectMode ? (
            <span className="pointer-events-none absolute left-2 top-2 z-10 rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--accent)]">
              Inspect mode — click an element
            </span>
          ) : null}
        </div>
      </div>

      <div className="absolute right-2 top-2 flex gap-1">
        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          aria-label="Toggle browser canvas fullscreen"
          title="Fullscreen (canvas only)"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
          </svg>
        </button>
      </div>
    </div>
  );
}
