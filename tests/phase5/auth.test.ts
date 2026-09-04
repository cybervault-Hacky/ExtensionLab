import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { closeDb, getDb, transaction } from "@/lib/db/client";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  createUser,
  deleteUser,
  findUserByEmail,
  findUserById,
  updateUserPassword,
} from "@/lib/db/repositories/users";
import {
  createSession,
  findSessionByTokenHash,
  deleteSession,
  listActiveSessions,
  deleteAllSessionsForUser,
} from "@/lib/db/repositories/sessions";
import { hashToken, generateAuthToken, generateResetToken } from "@/lib/auth/tokens";
import { restoreUser } from "@/lib/auth/session";
import { createPasswordReset, findPasswordReset, markPasswordResetUsed } from "@/lib/db/repositories/password-resets";
import { createExtension, getOwnedExtension, deleteExtension } from "@/lib/db/repositories/extensions";
import { createSnapshot } from "@/lib/db/repositories/snapshots";
import { createTestRun, getOwnedTestRun, saveTestRunFinal } from "@/lib/db/repositories/test-runs";
import { createReport, getOwnedReport, listReports } from "@/lib/db/repositories/reports";
import { createShare, getLiveShareByToken, revokeShare } from "@/lib/db/repositories/shares";
import { generateShareToken } from "@/lib/db/ids";
import { recordUsage, countUsageThisMonth } from "@/lib/db/repositories/usage";
import { recordAuditEvent } from "@/lib/db/repositories/audit";

beforeEach(() => {
  closeDb();
  process.env.EXTENSIONLAB_DB_PATH = ":memory:";
});

afterAll(() => {
  closeDb();
  delete process.env.EXTENSIONLAB_DB_PATH;
});

describe("password hashing", () => {
  it("hashes with a salt and verifies passwords", async () => {
    const hash = await hashPassword("secret123");
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain("secret123");
    expect(await verifyPassword("secret123", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("rejects weak passwords at the validation layer", () => {
    expect(validatePassword("short")).toEqual({ ok: false, message: "Password must be at least 8 characters." });
  });
});

import { validatePassword } from "@/lib/auth/validation";

describe("authentication lifecycle", () => {
  it("creates, restores, expires and deletes sessions", async () => {
    const passwordHash = await hashPassword("password123");
    const user = createUser({ email: "User@Example.com", passwordHash, name: "Test User" });

    const token = generateAuthToken();
    const session = createSession({
      userId: user.id,
      tokenHash: hashToken(token),
      ttlMs: 1000 * 60 * 60,
    });

    const restored = restoreUser(token);
    expect(restored?.email).toBe("user@example.com");
    expect(restored?.name).toBe("Test User");

    const row = findSessionByTokenHash(hashToken(token));
    expect(row?.id).toBe(session.id);
    deleteSession(session.id);
    expect(restoreUser(token)).toBeNull();

    const token2 = generateAuthToken();
    createSession({ userId: user.id, tokenHash: hashToken(token2), ttlMs: -1 });
    expect(restoreUser(token2)).toBeNull();
  });

  it("rejects duplicate emails after normalization", async () => {
    const hash = await hashPassword("password123");
    createUser({ email: "Duplicate@Example.com", passwordHash: hash, name: "One" });
    expect(() => createUser({ email: "duplicate@example.com", passwordHash: hash, name: "Two" })).toThrow();
    const rows = getDb().prepare("SELECT name FROM users WHERE email = ?").all("duplicate@example.com") as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
  });

  it("logs out all sessions except the current one", () => {
    const passwordHash = "scrypt$1";
    const user = createUser({ email: "session@example.com", passwordHash, name: "S" });
    const a = createSession({ userId: user.id, tokenHash: hashToken(generateAuthToken()), ttlMs: 1000 * 60 });
    const b = createSession({ userId: user.id, tokenHash: hashToken(generateAuthToken()), ttlMs: 1000 * 60 });
    deleteAllSessionsForUser(user.id, a.id);
    const rows = listActiveSessions(user.id);
    expect(rows.map((row) => row.id)).toEqual([a.id]);
    expect(rows.some((row) => row.id === b.id)).toBe(false);
  });
});

describe("password reset flow", () => {
  it("creates, applies and invalidates one-time reset tokens", async () => {
    const user = createUser({
      email: "reset@example.com",
      passwordHash: await hashPassword("oldpassword"),
      name: "Reset",
    });
    const token = generateResetToken();
    createPasswordReset({ userId: user.id, tokenHash: hashToken(token), expiresAt: Date.now() + 60_000 });
    const row = findPasswordReset(hashToken(token));
    expect(row?.user_id).toBe(user.id);

    markPasswordResetUsed(row!.id, Date.now());
    expect(findPasswordReset(hashToken(token))?.used_at).not.toBeNull();

    const nextHash = await hashPassword("newpassword");
    updateUserPassword(user.id, nextHash);
    expect(await verifyPassword("newpassword", findUserById(user.id)!.password_hash)).toBe(true);
  });
});

describe("ownership and report immutability", () => {
  it("enforces extension ownership and cascades account deletion", async () => {
    const a = createUser({ email: "a@example.com", passwordHash: "scrypt$1", name: "A" });
    const b = createUser({ email: "b@example.com", passwordHash: "scrypt$1", name: "B" });

    const ext = createExtension({
      userId: a.id,
      name: "Mine",
      version: "1.0",
      manifestVersion: "v3",
      sourceName: "a.zip",
      healthScore: 90,
    });

    expect(getOwnedExtension(a.id, ext.id)?.id).toBe(ext.id);
    expect(getOwnedExtension(b.id, ext.id)).toBeNull();

    const snapshot = createSnapshot({
      extensionId: ext.id,
      healthScore: 90,
      manifestVersion: "v3",
      analysisJson: JSON.stringify({ name: "Mine" }),
    });
    expect(snapshot.extension_id).toBe(ext.id);

    const run = createTestRun({ userId: a.id, extensionId: ext.id, status: "idle" });
    saveTestRunFinal({
      id: run.id,
      status: "completed",
      score: 80,
      total: 2,
      passed: 2,
      failed: 0,
      warnings: 0,
      skipped: 0,
      timeout: 0,
      errorCount: 0,
      completedAt: Date.now(),
      resultJson: JSON.stringify({ results: [] }),
      diagnosticsJson: "[]",
      eventsJson: "[]",
    });
    expect(getOwnedTestRun(a.id, run.id)?.extension_id).toBe(ext.id);

    const report = createReport({
      userId: a.id,
      extensionId: ext.id,
      analysisSnapshotId: snapshot.id,
      testRunId: run.id,
      title: "Report v1",
      summary: "s",
      healthScore: 90,
      runtimeScore: 80,
      overallScore: 85,
      reportJson: JSON.stringify({ name: "Mine" }),
    });
    expect(getOwnedReport(a.id, report.id)?.id).toBe(report.id);
    expect(getOwnedReport(b.id, report.id)).toBeNull();

    const shareToken = generateShareToken();
    createShare({ reportId: report.id, token: shareToken, expiresAt: null });
    expect(getLiveShareByToken(shareToken)?.report_id).toBe(report.id);
    const shareRow = getLiveShareByToken(shareToken)!;
    revokeShare(shareRow.id);
    expect(getLiveShareByToken(shareToken)).toBeNull();

    deleteUser(a.id);
    expect(findUserById(a.id)).toBeNull();
    expect(getOwnedExtension(a.id, ext.id)).toBeNull();
    expect(getOwnedReport(a.id, report.id)).toBeNull();
  });
});

describe("usage and audit", () => {
  it("tracks monthly usage and audit events without secrets", () => {
    const user = createUser({ email: "usage@example.com", passwordHash: "scrypt$1", name: "U" });
    recordUsage(user.id, "analysis");
    recordUsage(user.id, "analysis");
    recordUsage(user.id, "test_run");
    expect(countUsageThisMonth(user.id, "analysis")).toBe(2);
    expect(countUsageThisMonth(user.id, "test_run")).toBe(1);

    recordAuditEvent({ userId: user.id, type: "share_created", detail: "safe detail" });
    const db = getDb();
    const rows = db.prepare("SELECT type, detail FROM audit_events WHERE user_id = ?").all(user.id) as Array<{ type: string; detail: string }>;
    expect(rows.some((row) => row.type === "share_created")).toBe(true);
  });
});
