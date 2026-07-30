import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");

describe("canUseProviderAccount", () => {
  it("keeps ordinary provider access restricted to active accounts", async () => {
    const { canUseProviderAccount } = await import("./provider-runtime.service.js");

    expect(canUseProviderAccount("active", false)).toBe(true);
    expect(canUseProviderAccount("error", false)).toBe(false);
    expect(canUseProviderAccount("disabled", false)).toBe(false);
  });

  it("allows error accounts only for the explicit sync recovery path", async () => {
    const { canUseProviderAccount } = await import("./provider-runtime.service.js");

    expect(canUseProviderAccount("error", true)).toBe(true);
    expect(canUseProviderAccount("disabled", true)).toBe(false);
  });
});
