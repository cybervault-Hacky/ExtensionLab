import { getConfig } from "@/lib/config/env";
import { AppError } from "@/lib/observability/errors";
import { logger, recordMetric } from "@/lib/observability/logger";
import { ConsoleEmailProvider } from "./providers/console";
import { FileEmailProvider } from "./providers/file";
import { HttpEmailProvider } from "./providers/http";
import { NoopEmailProvider } from "./providers/noop";
import { renderPasswordResetEmail } from "./templates";
import type { EmailMessage, EmailProvider } from "./types";

let provider: EmailProvider | null = null;
let providerKey = "";
let override: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (override) return override;
  const config = getConfig();
  const key = `${config.email.provider}:${config.email.httpUrl ?? ""}:${config.email.fileDir ?? ""}`;
  if (provider && providerKey === key) return provider;
  switch (config.email.provider) {
    case "console":
      provider = new ConsoleEmailProvider();
      break;
    case "file":
      provider = new FileEmailProvider(config.email.fileDir ?? "./data/outbox");
      break;
    case "http":
      provider = new HttpEmailProvider(config.email.httpUrl ?? "", config.email.httpToken ?? "");
      break;
    case "noop":
    default:
      provider = new NoopEmailProvider();
  }
  providerKey = key;
  return provider;
}

/** Test hook: pins a provider regardless of configuration (null clears it). */
export function setEmailProviderForTests(next: EmailProvider | null): void {
  override = next;
  provider = null;
  providerKey = "";
}

/**
 * Sends a rendered message through the configured provider. Throws a
 * retryable `EMAIL_DELIVERY_FAILED` for transient failures so the job system
 * can back off, and a non-retryable one for permanent failures. Logs never
 * include the message body or the recipient address.
 */
export async function sendEmail(message: EmailMessage): Promise<void> {
  const config = getConfig();
  const active = getEmailProvider();
  const startedAt = Date.now();
  const result = await active.send(message, { from: config.email.from });
  recordMetric("email.sent", result.ok ? 1 : 0, { provider: active.name });
  if (result.ok) {
    logger.info("email.sent", { provider: active.name, durationMs: Date.now() - startedAt, result: "ok" });
    return;
  }
  logger.warn("email.failed", {
    provider: active.name,
    durationMs: Date.now() - startedAt,
    errorCode: "EMAIL_DELIVERY_FAILED",
    transient: result.transient === true,
    detail: result.detail,
  });
  throw new AppError("EMAIL_DELIVERY_FAILED", { retryable: result.transient === true });
}

export function renderTemplate(template: string, variables: Record<string, string>, to: string): EmailMessage {
  switch (template) {
    case "password-reset":
      return renderPasswordResetEmail({
        to,
        resetUrl: variables.resetUrl ?? "",
        expiresMinutes: Number(variables.expiresMinutes ?? "30") || 30,
      });
    default:
      throw new AppError("INVALID_INPUT", { message: "Unknown email template.", retryable: false });
  }
}
