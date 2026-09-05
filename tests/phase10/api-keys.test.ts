import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createApiKey, revokeApiKeyById, listOrganizationApiKeys, authenticateApiKey, API_SCOPES } from "@/lib/api-keys/service";
import { createOrganization, setOrganizationPlan } from "@/lib/organizations/service";
import { insertMember } from "@/lib/organizations/repository";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/observability/errors";
import { makeUser, setupHarness, type Harness } from "./helpers";

let harness: Harness;

beforeEach(() => {
  harness = setupHarness();
});

afterEach(() => {
  harness.teardown();
});

function proOrg(): { org: string; owner: string } {
  const owner = makeUser();
  const org = createOrganization({ userId: owner.id }, { name: "Key Co" });
  setOrganizationPlan({ organizationId: org.id, planId: "pro", status: "active", seats: 10 });
  return { org: org.id, owner: owner.id };
}

function requestWithKey(key: string | null): NextRequest {
  return new NextRequest("https://app.example.com/api/v1/organization", {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
}

describe("API key lifecycle", () => {
  it("creates keys that are hashed at rest with a prefix and least-privilege default scopes", () => {
    const { org, owner } = proOrg();
    const created = createApiKey({ userId: owner, organizationId: org }, { name: "CI" });
    expect(created.key).toMatch(/^el_[a-f0-9]{6}_/);
    expect(created.scopes).toEqual(["packages:read", "analysis:read", "tests:read"]);
    // Stored hash is sha256, not the raw key.
    const row = getDb().prepare("SELECT key_hash, prefix FROM organization_api_keys WHERE id = ?").get(created.id) as { key_hash: string; prefix: string };
    expect(row.key_hash).not.toContain(created.key.split("_")[2]);
    expect(row.key_hash).toHaveLength(64);
    expect(row.prefix).toMatch(/^[a-f0-9]{6}$/);
    expect(created.key.startsWith(`el_${row.prefix}_`)).toBe(true);
  });

  it("only owners/admins can create and revoke keys", () => {
    const { org, owner } = proOrg();
    const developer = makeUser();
    insertMember({ organizationId: org, userId: developer.id, role: "developer" });
    expect(() => createApiKey({ userId: developer.id, organizationId: org }, { name: "nope" })).toThrowError(AppError);
    const created = createApiKey({ userId: owner, organizationId: org }, { name: "ok" });
    expect(() => revokeApiKeyById({ userId: developer.id, organizationId: org }, created.id)).toThrowError(AppError);
    revokeApiKeyById({ userId: owner, organizationId: org }, created.id);
    expect(() => authenticateApiKey(requestWithKey(created.key), "packages:read")).toThrowError(AppError);
  });

  it("validates scopes and rejects empty/unrestricted selections", () => {
    const { org, owner } = proOrg();
    expect(() => createApiKey({ userId: owner, organizationId: org }, { name: "x", scopes: [] })).toThrowError(AppError);
    expect(() => createApiKey({ userId: owner, organizationId: org }, { name: "x", scopes: ["*"] })).toThrowError(AppError);
    expect(() => createApiKey({ userId: owner, organizationId: org }, { name: "x", scopes: ["not:a:scope"] })).toThrowError(AppError);
    const all = createApiKey({ userId: owner, organizationId: org }, { name: "x", scopes: [...API_SCOPES] });
    expect(all.scopes.length).toBe(API_SCOPES.length);
  });

  it("expiry is enforced at authentication time", () => {
    const { org, owner } = proOrg();
    const longLived = createApiKey({ userId: owner, organizationId: org }, { name: "short", expiresAt: Date.now() + 60_000 });
    const row = getDb().prepare("UPDATE organization_api_keys SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, longLived.id);
    expect(Number(row.changes)).toBe(1);
    expect(() => authenticateApiKey(requestWithKey(longLived.key))).toThrowError(AppError);
  });

  it("authentication resolves principal, scopes and creator role; unknown keys fail closed", () => {
    const { org, owner } = proOrg();
    const created = createApiKey({ userId: owner, organizationId: org }, { name: "k", scopes: ["packages:read", "packages:write"] });
    const principal = authenticateApiKey(requestWithKey(created.key), "packages:write");
    expect(principal.organizationId).toBe(org);
    expect(principal.creatorRole).toBe("owner");
    expect(principal.scopes).toContain("packages:write");
    expect(() => authenticateApiKey(requestWithKey(created.key), "webhooks:read")).toThrowError(AppError);
    expect(() => authenticateApiKey(requestWithKey("el_deadbeef_nope"))).toThrowError(AppError);
    expect(() => authenticateApiKey(requestWithKey(null))).toThrowError(AppError);
  });

  it("free-plan organizations cannot mint API keys (entitlement gate)", () => {
    const owner = makeUser();
    const org = createOrganization({ userId: owner.id }, { name: "Free Co" });
    expect(() => createApiKey({ userId: owner.id, organizationId: org.id }, { name: "k" })).toThrowError(AppError);
  });

  it("listing never exposes secrets", () => {
    const { org, owner } = proOrg();
    createApiKey({ userId: owner, organizationId: org }, { name: "a" });
    createApiKey({ userId: owner, organizationId: org }, { name: "b" });
    const keys = listOrganizationApiKeys({ userId: owner, organizationId: org });
    expect(keys).toHaveLength(2);
    const serialized = JSON.stringify(keys);
    expect(serialized).not.toMatch(/el_[a-f0-9]{6}/);
  });
});
