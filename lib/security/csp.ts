/**
 * Content-Security-Policy builder shared by the middleware (pages) and tests.
 *
 * Runtime-agnostic on purpose: this file is imported from the Edge middleware,
 * so it must not touch Node-only modules.
 *
 * Policy highlights:
 * - No `unsafe-eval`, ever, in production. Uploaded extension code is never
 *   evaluated by the web app; it only runs inside the isolated sandbox browser.
 * - Scripts are nonce-gated. Next.js picks up the nonce from the request CSP
 *   header and applies it to its own inline bootstrap scripts; the theme
 *   script in `app/layout.tsx` receives the same nonce.
 * - `style-src 'unsafe-inline'` is retained because React renders inline
 *   `style=""` attributes (accent theming, progress widths). Style attributes
 *   cannot be nonce'd; this does not weaken script execution restrictions.
 * - Images are same-origin only (`data:`/`blob:` for icons and previews);
 *   screenshots are streamed through `/api/artifacts/:id`.
 */
export interface CspOptions {
  nonce: string;
  /** Adds `'unsafe-eval'` for the Next.js development overlay/HMR only. */
  development?: boolean;
  /** Emits `upgrade-insecure-requests` (production behind TLS). */
  upgradeInsecureRequests?: boolean;
}

export function buildContentSecurityPolicy(options: CspOptions): string {
  const scriptSources = [`'self'`, `'nonce-${options.nonce}'`, `'strict-dynamic'`];
  if (options.development) scriptSources.push(`'unsafe-eval'`);

  const directives = [
    `default-src 'self'`,
    `script-src ${scriptSources.join(" ")}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self'`,
    `media-src 'none'`,
    `object-src 'none'`,
    `worker-src 'self' blob:`,
    `frame-src 'none'`,
    `frame-ancestors 'self'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `manifest-src 'self'`,
  ];
  if (options.upgradeInsecureRequests) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** Policy for JSON/binary API responses: nothing may execute or embed. */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";

const NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 128-bit+ random nonce using the Web Crypto API (available in Edge and Node). */
export function generateNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += NONCE_ALPHABET[byte % NONCE_ALPHABET.length];
  return out;
}
