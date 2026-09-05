import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb, transaction } from "@/lib/db/client";
import { createPasswordReset, invalidateUserPasswordResets } from "@/lib/db/repositories/password-resets";
import { generateResetToken, hashToken } from "@/lib/auth/tokens";
import { enqueueJob } from "@/lib/jobs/queue";
import { ensureEmbeddedWorker, notifyEmbeddedWorker } from "@/lib/jobs/runtime";
import { getConfig } from "@/lib/config/env";
import { logger } from "@/lib/observability/logger";
import { isSafeId } from "@/lib/auth/validation";

export const PASSWORD_RESET_TTL_MINUTES = 30;

/**
 * Issues a password-reset token for `user` and queues the delivery e-mail.
 *
 * - Only the token hash is persisted; the raw token travels once, inside the
 *   reset link of the queued EMAIL job payload, and is never logged.
 * - The reset row and the job are created in one transaction, so a queued
 *   e-mail always corresponds to a valid token.
 * - Development-only file delivery (EXTENSIONLAB_RESET_DEV_DIR) is preserved;
 *   the config layer refuses that variable in production.
 */
export async function issuePasswordReset(user: { id: string; email: string }): Promise<void> {
  const config = getConfig();
  const token = generateResetToken();
  const expiresAt = Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000;
  const resetUrl = `${config.appUrl}/reset-password?token=${encodeURIComponent(token)}`;

  transaction(getDb(), () => {
    invalidateUserPasswordResets(user.id);
    createPasswordReset({ userId: user.id, tokenHash: hashToken(token), expiresAt });
    if (config.email.provider !== "noop") {
      enqueueJob({
        type: "EMAIL",
        userId: user.id,
        payload: {
          template: "password-reset",
          to: user.email,
          variables: { resetUrl, expiresMinutes: String(PASSWORD_RESET_TTL_MINUTES) },
        },
        maxAttempts: Math.max(1, config.jobs.maxRetries + 1),
        priority: 5,
        skipBackpressure: true,
      });
    }
  });

  if (config.email.provider !== "noop") {
    ensureEmbeddedWorker();
    notifyEmbeddedWorker();
  }

  if (config.resetDevDir && config.appEnv !== "production" && isSafeId(user.id)) {
    // Development-only file-based delivery for local testing. Never enabled in
    // production (rejected by config validation) and never written to logs.
    await mkdir(config.resetDevDir, { recursive: true }).catch(() => undefined);
    await writeFile(join(config.resetDevDir, `${user.id}.reset-token`), token, "utf8").catch(() => undefined);
  }

  logger.info("auth.password_reset.issued", { userId: user.id, delivery: config.email.provider });
}
