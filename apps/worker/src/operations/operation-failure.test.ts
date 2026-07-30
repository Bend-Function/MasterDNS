import { ProviderError } from "@masterdns/contracts";
import type { ProviderRecord } from "@masterdns/contracts";
import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");

describe("operation step failure disposition", () => {
  it("keeps disabled-provider work pending even for a non-retryable error", async () => {
    const { shouldFinalizeOperationStepFailure } = await import("./operation.processor.js");

    expect(shouldFinalizeOperationStepFailure({
      retryable: false,
      attemptsMade: 4,
      maxAttempts: 5,
      providerStatus: "disabled",
      lockFailure: false,
    })).toBe(false);
  });

  it("keeps lock contention pending after the BullMQ attempt budget is exhausted", async () => {
    const { shouldFinalizeOperationStepFailure } = await import("./operation.processor.js");

    expect(shouldFinalizeOperationStepFailure({
      retryable: true,
      attemptsMade: 4,
      maxAttempts: 5,
      providerStatus: "active",
      lockFailure: true,
    })).toBe(false);
  });

  it("finalizes ordinary permanent errors and exhausted transient errors", async () => {
    const { shouldFinalizeOperationStepFailure } = await import("./operation.processor.js");

    expect(shouldFinalizeOperationStepFailure({
      retryable: false,
      attemptsMade: 0,
      maxAttempts: 5,
      providerStatus: "active",
      lockFailure: false,
    })).toBe(true);
    expect(shouldFinalizeOperationStepFailure({
      retryable: true,
      attemptsMade: 4,
      maxAttempts: 5,
      providerStatus: "active",
      lockFailure: false,
    })).toBe(true);
  });

  it("does not re-run an operation after any terminal result", async () => {
    const { isTerminalOperationStatus } = await import("./operation.processor.js");

    expect((["succeeded", "partial", "failed", "superseded"] as const).every(isTerminalOperationStatus)).toBe(true);
    expect((["pending", "running"] as const).some(isTerminalOperationStatus)).toBe(false);
  });
});

describe("idempotent provider deletion", () => {
  const existing: ProviderRecord = {
    externalId: "record-1",
    zoneExternalId: "zone-1",
    type: "A",
    name: "www.example.com",
    content: "192.0.2.1",
    ttl: 300,
    providerMetadata: {},
  };

  it.each(["cloudflare", "aliyun"] as const)("verifies absence after %s reports not_found", async (provider) => {
    const { deleteRemoteRecordAndVerify } = await import("./operation.processor.js");
    const adapter = {
      provider,
      getRecord: vi.fn()
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(null),
      deleteRecord: vi.fn().mockRejectedValue(new ProviderError("already deleted", "not_found", provider)),
    };

    await expect(deleteRemoteRecordAndVerify(adapter as never, "zone-1", "record-1")).resolves.toBeUndefined();
    expect(adapter.deleteRecord).toHaveBeenCalledOnce();
    expect(adapter.getRecord).toHaveBeenCalledTimes(2);
  });

  it("still fails when the record remains after a not_found delete response", async () => {
    const { deleteRemoteRecordAndVerify } = await import("./operation.processor.js");
    const adapter = {
      provider: "cloudflare" as const,
      getRecord: vi.fn().mockResolvedValue(existing),
      deleteRecord: vi.fn().mockRejectedValue(new ProviderError("ambiguous response", "not_found", "cloudflare")),
    };

    await expect(deleteRemoteRecordAndVerify(adapter as never, "zone-1", "record-1"))
      .rejects.toMatchObject({ code: "transient_failure" });
    expect(adapter.getRecord).toHaveBeenCalledTimes(2);
  });
});
