import { describe, expect, it } from "vitest";
import { createZoneInputSchema, createZonesInputSchema, zoneNameSchema } from "./zones.js";

const account = { providerAccountId: "3ebae6b0-ff56-4dd0-a1f4-42b8af07aa65", cloudflareAccountId: "a".repeat(32) };

describe("zone creation inputs", () => {
  it.each([
    [" Example.COM. ", "example.com"],
    ["例子.中国", "xn--fsqu00a.xn--fiqs8s"],
    ["sub.example.co.uk", "sub.example.co.uk"],
  ])("normalizes %s before submitting it to Cloudflare", (input, expected) => {
    expect(zoneNameSchema.parse(input)).toBe(expected);
  });

  it.each(["", "localhost", "192.0.2.1", "https://example.com", "example.com/path", "example.com:443", "user@example.com", "*.example.com", "bad_name.com", "bad..com", "-bad.com", "bad-.com", "example.123", `${"a".repeat(64)}.com`, `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`])("rejects invalid zone %s", name => {
    expect(zoneNameSchema.safeParse(name).success).toBe(false);
  });

  it("requires both the local provider account and Cloudflare account identity", () => {
    expect(createZoneInputSchema.parse({ ...account, name: "Example.COM" }).name).toBe("example.com");
    expect(createZoneInputSchema.safeParse({ ...account, cloudflareAccountId: "invalid", name: "example.com" }).success).toBe(false);
    expect(createZoneInputSchema.safeParse({ ...account, providerAccountId: "invalid", name: "example.com" }).success).toBe(false);
  });

  it("deduplicates normalized batch names and bounds the batch before provider calls", () => {
    expect(createZonesInputSchema.parse({ ...account, names: ["A.COM", "a.com.", "b.com"] }).names).toEqual(["a.com", "b.com"]);
    expect(createZonesInputSchema.safeParse({ ...account, names: [] }).success).toBe(false);
    expect(createZonesInputSchema.safeParse({ ...account, names: ["a.com", "invalid"] }).success).toBe(false);
    expect(createZonesInputSchema.safeParse({ ...account, names: Array.from({ length: 101 }, (_, i) => `example${i}.com`) }).success).toBe(false);
  });
});
