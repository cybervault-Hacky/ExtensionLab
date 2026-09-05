import type { EmailMessage, EmailProvider, EmailSendResult } from "../types";

/**
 * Development provider: prints the message to stdout. Disallowed in
 * production by configuration validation. Reset links contain a one-time
 * token, which is the delivery mechanism itself — never route this output to
 * shared log storage.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";

  async send(message: EmailMessage, options: { from: string }): Promise<EmailSendResult> {
    const lines = [
      "",
      "================ ExtensionLab email (development) ================",
      `From: ${options.from}`,
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      "",
      message.text,
      "==================================================================",
      "",
    ];
    process.stdout.write(lines.join("\n"));
    return { ok: true, providerMessageId: `console-${Date.now()}` };
  }
}
