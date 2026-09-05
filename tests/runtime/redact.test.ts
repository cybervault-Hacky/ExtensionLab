import { describe, expect, it } from "vitest";
import { redactHeaders, redactSensitiveText, redactUrlShallow } from "@/lib/runtime/redact";

describe("runtime redaction", () => {
  it("redacts sensitive query parameters", () => {
    expect(redactUrlShallow("https://x.test/path?token=abc&x=1")).toBe(
      "https://x.test/path?token=REDACTED&x=1",
    );
  });

  it("truncates very long URLs", () => {
    const url = `https://x.test/${"a".repeat(1000)}`;
    const result = redactUrlShallow(url);
    expect(result.length).toBeLessThan(url.length);
    expect(result.endsWith("…")).toBe(true);
  });

  it("drops sensitive headers", () => {
    const headers = redactHeaders({
      authorization: "Bearer secret",
      cookie: "session=1",
      "x-api-key": "k",
      "content-type": "application/json",
    });
    expect(headers).toEqual({ "content-type": "[redacted]" });
  });

  it("redacts bearer tokens in text", () => {
    expect(redactSensitiveText("Authorization: Bearer abc123")).toMatch(
      /REDACTED/,
    );
  });
});
