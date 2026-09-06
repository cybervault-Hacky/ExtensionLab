/**
 * Phase 12 pointer coordinate mapping (pure, shared by the browser canvas and
 * tests; NO server-only import so the client bundle can use it).
 *
 * The mapping is CSS-pixel based: the canvas <img> renders the frame at the
 * session viewport's aspect ratio, so its bounding rect already encodes both
 * responsive resizing and letterboxing. Device pixel ratio only affects
 * rendering sharpness — getBoundingClientRect() reports CSS pixels, which is
 * exactly the coordinate space CDP input expects.
 *
 * The SERVER-SENT viewport (session.viewport / popup size) is authoritative;
 * this mapping is a best-effort client convenience and every action is
 * re-validated server-side against the real viewport before it can reach the
 * runner. Anything outside the canvas maps to null — never clamped into range.
 */

export interface PointerMapping {
  x: number;
  y: number;
}

export interface MappingInput {
  /** Pointer position in page CSS pixels (e.g. clientX/clientY). */
  clientX: number;
  clientY: number;
  /** Rendered canvas bounding rect (CSS pixels, from getBoundingClientRect). */
  rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  /** The session's real viewport (server-authoritative). */
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * Maps a pointer position onto the browser viewport. Returns null when the
 * pointer is outside the rendered canvas (including a zero-sized canvas) —
 * clicks must be dropped, not clamped.
 */
export function mapPointerToViewport(input: MappingInput): PointerMapping | null {
  const { clientX, clientY, rect, viewportWidth, viewportHeight } = input;
  if (rect.width <= 0 || rect.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return null;
  }
  const withinCanvas =
    clientX >= rect.left && clientX <= rect.left + rect.width && clientY >= rect.top && clientY <= rect.top + rect.height;
  if (!withinCanvas) return null;

  const scaleX = viewportWidth / rect.width;
  const scaleY = viewportHeight / rect.height;
  const x = Math.round((clientX - rect.left) * scaleX);
  const y = Math.round((clientY - rect.top) * scaleY);
  // Rounding at the far edge can land one pixel outside; that is still a valid
  // target for the browser (coordinates may equal the viewport edge), but a
  // DEGREES-of-freedom beyond the edge must reject.
  if (x < 0 || y < 0 || x > viewportWidth || y > viewportHeight) return null;
  return { x, y };
}

/**
 * The display scale factor between the real viewport and the rendered canvas
 * (used for scroll-delta correction so scrolling feels 1:1 at any size).
 */
export function canvasScale(rect: { width: number }, viewportWidth: number): number {
  if (rect.width <= 0 || viewportWidth <= 0) return 1;
  return viewportWidth / rect.width;
}
