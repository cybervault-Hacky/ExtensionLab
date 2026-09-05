import type { EmailMessage } from "./types";

/**
 * Server-rendered templates. Only the template id and plain string variables
 * travel through the job payload.
 */
export function renderPasswordResetEmail(input: { to: string; resetUrl: string; expiresMinutes: number; appName?: string }): EmailMessage {
  const appName = input.appName ?? "ExtensionLab";
  const text = [
    `Someone requested a password reset for your ${appName} account.`,
    "",
    `Reset your password using this link (valid for ${input.expiresMinutes} minutes):`,
    input.resetUrl,
    "",
    "If you did not request this, you can safely ignore this message.",
  ].join("\n");
  const html = `<p>Someone requested a password reset for your ${escapeHtml(appName)} account.</p>
<p>Reset your password using this link (valid for ${input.expiresMinutes} minutes):<br>
<a href="${escapeAttribute(input.resetUrl)}">${escapeHtml(input.resetUrl)}</a></p>
<p>If you did not request this, you can safely ignore this message.</p>`;
  return { to: input.to, subject: `Reset your ${appName} password`, text, html };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
