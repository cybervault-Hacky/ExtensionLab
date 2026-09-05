import type { EmailMessage, EmailProvider, EmailSendResult } from "../types";

/**
 * Generic HTTPS JSON provider.
 *
 * Posts `{ from, to, subject, text, html }` with a bearer token to the
 * configured endpoint. Most transactional email services (or a tiny relay in
 * front of one) accept this shape, which keeps vendor SDKs out of the
 * codebase. 5xx/429/network errors are transient; 4xx are permanent.
 */
export class HttpEmailProvider implements EmailProvider {
  readonly name = "http";

  constructor(private readonly url: string, private readonly token: string, private readonly timeoutMs = 10_000) {}

  async send(message: EmailMessage, options: { from: string }): Promise<EmailSendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ from: options.from, to: message.to, subject: message.subject, text: message.text, html: message.html }),
        signal: controller.signal,
      });
      if (response.ok) {
        let id: string | undefined;
        try {
          const body = (await response.json()) as { id?: unknown; messageId?: unknown };
          id = typeof body.id === "string" ? body.id : typeof body.messageId === "string" ? body.messageId : undefined;
        } catch {
          id = undefined;
        }
        return { ok: true, providerMessageId: id };
      }
      const transient = response.status === 429 || response.status >= 500;
      return { ok: false, transient, detail: `http_${response.status}` };
    } catch {
      return { ok: false, transient: true, detail: "network_error" };
    } finally {
      clearTimeout(timer);
    }
  }
}
