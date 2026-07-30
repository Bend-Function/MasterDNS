import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");

describe("provider sync notification transitions", () => {
  it("notifies on the first error and when the error classification changes", async () => {
    const { shouldNotifyProviderError } = await import("./sync.processor.js");

    expect(shouldNotifyProviderError("active", null, "authentication_failed")).toBe(true);
    expect(shouldNotifyProviderError("error", "authentication_failed", "permission_denied")).toBe(true);
  });

  it("deduplicates a repeated error and emits recovery only from error state", async () => {
    const { shouldNotifyProviderError, shouldNotifyProviderRecovery } = await import("./sync.processor.js");

    expect(shouldNotifyProviderError("error", "authentication_failed", "authentication_failed")).toBe(false);
    expect(shouldNotifyProviderRecovery("error")).toBe(true);
    expect(shouldNotifyProviderRecovery("active")).toBe(false);
    expect(shouldNotifyProviderRecovery("disabled")).toBe(false);
  });
});
