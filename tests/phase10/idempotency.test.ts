import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { withIdempotency, deleteExpiredIdempotencyRecords } from "@/lib/idempotency/service";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/observability/errors";
import { makeUser, setupHarness, type Harness } from "./helpers";

let harness: Harness;
let calls: number;

beforeEach(() => {
  harness = setupHarness();
  calls = 0;
});

afterEach(() => {
  harness.teardown();
});

const operation = (status: number, body: Record<string, unknown>) => async () => {
  calls += 1;
  return { status, body };
};

const orgOwner = (id: string) => ({ type: "organization" as const, id });
const userOwner = (id: string) => ({ type: "user" as const, id });

describe("idempotency", () => {
  it("replays the stored response without re-running the operation", async () => {
    const owner = orgOwner(makeUser().id);
    const first = await withIdempotency(owner, "build-1", "POST /x", "fp", operation(201, { id: "pkg_1" }));
    expect(first.body).toEqual({ id: "pkg_1" });
    const second = await withIdempotency(owner, "build-1", "POST /x", "fp", operation(500, { id: "other" }));
    expect(second.body).toEqual({ id: "pkg_1" });
    expect(second.status).toBe(201);
    expect(calls).toBe(1);
  });

  it("same key with a different body conflicts", async () => {
    const owner = orgOwner(makeUser().id);
    await withIdempotency(owner, "build-2", "POST /x", "fp-a", operation(201, { ok: true }));
    await expect(withIdempotency(owner, "build-2", "POST /x", "fp-b", operation(201, { ok: true }))).rejects.toThrowError(AppError);
  });

  it("keys are scoped per owner — the same key in another org is a fresh record", async () => {
    const a = orgOwner(makeUser().id);
    const b = orgOwner(makeUser().id);
    await withIdempotency(a, "shared", "POST /x", "fp", operation(201, { who: "a" }));
    const fromB = await withIdempotency(b, "shared", "POST /x", "fp", operation(201, { who: "b" }));
    expect(fromB.body).toEqual({ who: "b" });
    const personal = await withIdempotency(userOwner(makeUser().id), "shared", "POST /x", "fp", operation(201, { who: "personal" }));
    expect(personal.body).toEqual({ who: "personal" });
    expect(calls).toBe(3);
  });

  it("failures are not cached — a retry after an error re-runs", async () => {
    const owner = orgOwner(makeUser().id);
    let attempt = 0;
    const flaky = async () => {
      calls += 1;
      attempt += 1;
      if (attempt === 1) throw new AppError("STORAGE_ERROR");
      return { status: 201, body: { attempt } };
    };
    await expect(withIdempotency(owner, "build-3", "POST /x", "fp", flaky)).rejects.toThrowError(AppError);
    const retried = await withIdempotency(owner, "build-3", "POST /x", "fp", flaky);
    expect(retried.body).toEqual({ attempt: 2 });
    expect(calls).toBe(2);
  });

  it("no key means no idempotency bookkeeping", async () => {
    const owner = orgOwner(makeUser().id);
    await withIdempotency(owner, null, "POST /x", "fp", operation(201, { a: 1 }));
    await withIdempotency(owner, "", "POST /x", "fp", operation(201, { a: 1 }));
    expect(calls).toBe(2);
  });

  it("expired records are swept", async () => {
    const owner = orgOwner(makeUser().id);
    await withIdempotency(owner, "build-4", "POST /x", "fp", operation(201, { ok: true }));
    getDb().prepare("UPDATE api_idempotency_records SET expires_at = 1").run();
    expect(deleteExpiredIdempotencyRecords()).toBe(1);
    const replay = await withIdempotency(owner, "build-4", "POST /x", "fp", operation(201, { ok: "fresh" }));
    expect(replay.body).toEqual({ ok: "fresh" });
  });
});
