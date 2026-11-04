/**
 * Controlled public-preview guard.
 *
 * This flag is intentionally server-only: it is read by middleware and server
 * components, never exposed through a NEXT_PUBLIC variable. A controlled
 * preview may expose the browser-local inspection experience, but it must not
 * accept requests that require persistent application infrastructure.
 */
export function isControlledPublicPreview(): boolean {
  return process.env.EXTENSIONLAB_PREVIEW_MODE?.trim().toLowerCase() === "controlled";
}
