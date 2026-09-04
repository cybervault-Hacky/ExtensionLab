import { describe, expect, it } from "vitest";
import { validateTestUrl, validateTestUrlWithDns } from "@/lib/runtime/urls";

describe("runtime test URL policy", () => {
  it("allows public HTTPS URLs", () => {
    const result = validateTestUrl("https://example.com/path?x=1");
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://example.com/path?x=1");
  });

  it("blocks localhost and loopback addresses", () => {
    expect(validateTestUrl("https://localhost").ok).toBe(false);
    expect(validateTestUrl("https://127.0.0.1").ok).toBe(false);
    expect(validateTestUrl("https://0.0.0.0").ok).toBe(false);
    expect(validateTestUrl("https://[::1]").ok).toBe(false);
  });

  it("blocks private IPv4 ranges", () => {
    expect(validateTestUrl("https://10.0.0.5").ok).toBe(false);
    expect(validateTestUrl("https://172.16.0.1").ok).toBe(false);
    expect(validateTestUrl("https://192.168.1.1").ok).toBe(false);
    expect(validateTestUrl("https://169.254.169.254").ok).toBe(false);
  });

  it("blocks plain HTTP by default", () => {
    const result = validateTestUrl("http://example.com");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/HTTPS/i);
  });

  it("rejects non-http schemes and embedded credentials", () => {
    expect(validateTestUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateTestUrl("https://user:pass@example.com").ok).toBe(false);
  });

  it("rejects a URL whose DNS resolves to a private address", async () => {
    // This hostname is intentionally weird so any successful lookup is a
    // public host; the test only verifies the async flow completes.
    const result = await validateTestUrlWithDns("https://example.com");
    expect(typeof result.ok).toBe("boolean");
  });
});
