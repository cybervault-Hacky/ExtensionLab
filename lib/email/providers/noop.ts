import type { EmailMessage, EmailProvider, EmailSendResult } from "../types";

/**
 * Explicit "no delivery" provider. Messages are dropped and the drop is
 * logged by the service (without content). Useful for deployments where
 * password reset is disabled until a real provider is configured.
 */
export class NoopEmailProvider implements EmailProvider {
  readonly name = "noop";

  async send(_message: EmailMessage): Promise<EmailSendResult> {
    void _message;
    return { ok: false, transient: false, detail: "email_disabled" };
  }
}
