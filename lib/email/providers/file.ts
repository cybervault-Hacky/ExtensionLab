import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { EmailMessage, EmailProvider, EmailSendResult } from "../types";

/** Development/E2E provider: writes each message as a JSON file. Not allowed in production. */
export class FileEmailProvider implements EmailProvider {
  readonly name = "file";

  constructor(private readonly directory: string) {}

  async send(message: EmailMessage, options: { from: string }): Promise<EmailSendResult> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
      await writeFile(
        join(this.directory, `${id}.json`),
        JSON.stringify({ from: options.from, ...message, sentAt: Date.now() }, null, 2),
        { mode: 0o600 },
      );
      return { ok: true, providerMessageId: id };
    } catch {
      return { ok: false, transient: true, detail: "file_write_failed" };
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      return { ok: true };
    } catch {
      return { ok: false, detail: "directory_unavailable" };
    }
  }
}
