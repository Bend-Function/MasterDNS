import { bindingAssignments, domainBindings, endpointPools, failoverEvents, reconcileIntents } from "@masterdns/db";
import { providerRecordHash } from "@masterdns/providers";
import { describe, expect, it, vi } from "vitest";
import { DnsZoneLockError } from "./dns-zone-lock.js";

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
    expect(shouldNotifyProviderError("disabled", null, "authentication_failed")).toBe(false);
  });

  it("does not classify lock contention as a provider failure", async () => {
    const { shouldUpdateProviderStatusAfterSyncFailure } = await import("./sync.processor.js");

    expect(shouldUpdateProviderStatusAfterSyncFailure(new DnsZoneLockError("contended", "timeout"))).toBe(false);
    expect(shouldUpdateProviderStatusAfterSyncFailure(new Error("provider request failed"))).toBe(true);
  });

  it("accepts a legacy Aliyun status hash when the semantic record is unchanged", async () => {
    const { hasSemanticRecordDrift } = await import("./sync.processor.js");
    const local = {
      type: "A",
      name: "www.example.com",
      content: "192.0.2.1",
      ttl: 600,
      priority: null,
      providerMetadata: { line: "default", status: "ENABLE" },
      remoteHash: "legacy-pre-normalization-hash",
    };
    const remoteHash = providerRecordHash({
      type: local.type,
      name: local.name,
      content: local.content,
      ttl: local.ttl,
      providerMetadata: { line: "default", status: "Enable" },
    });

    expect(hasSemanticRecordDrift(local as never, remoteHash)).toBe(false);
  });

  it("does not classify a recovery notification enqueue failure as a provider failure", async () => {
    const { SyncProcessor } = await import("./sync.processor.js");
    const account = {
      id: "provider-1",
      status: "error",
      errorCode: "sync_failed",
      ownerUserId: "owner-1",
      name: "Cloudflare",
    };
    const updates: Array<Record<string, unknown>> = [];
    const database = {
      db: {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn(async () => [account]) })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn((values: Record<string, unknown>) => {
            updates.push(values);
            return {
              where: vi.fn(() => ({ returning: vi.fn(async () => [{ id: account.id }]) })),
            };
          }),
        })),
      },
    };
    const providers = {
      forAccount: vi.fn(async () => ({
        adapter: { listZones: vi.fn(async () => ({ items: [] })) },
      })),
    };
    const queues = {
      notifications: { add: vi.fn(async () => { throw new Error("notification queue unavailable"); }) },
    };
    const processor = new SyncProcessor(database as never, providers as never, queues as never);
    const logError = vi.spyOn((processor as any).logger, "error").mockImplementation(() => undefined);

    await expect((processor as any).process({ data: { providerAccountId: account.id } })).resolves.toBeUndefined();

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "active", errorCode: null });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("Failed to enqueue provider recovery notification"));
  });
});

describe("provider drift repair durability", () => {
  it("records drift and its repair intent before a concurrent provider disable can stop sync", async () => {
    const { SyncProcessor } = await import("./sync.processor.js");
    const sequence: string[] = [];
    const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const tx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn(async () => table === bindingAssignments ? [{ id: "binding-1" }] : []),
        })),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn(() => ({
          where: vi.fn(() => table === endpointPools
            ? { returning: vi.fn(async () => [{ decisionRevision: 12, policyRevision: 5 }]) }
            : Promise.resolve([])),
        })),
      })),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn(async (values: Record<string, unknown>) => {
          inserts.push({ table, values });
          if (table === reconcileIntents) sequence.push("intent");
          return [];
        }),
      })),
    };
    const database = { db: { transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) } };
    const queues = {
      notifications: { add: vi.fn(async () => { sequence.push("notification"); }) },
    };
    const processor = new SyncProcessor(database as never, {} as never, queues as never);

    await (processor as any).recordDrift({
      id: "record-1",
      managedByPoolId: "22222222-2222-4222-8222-222222222222",
      remoteHash: "expected-hash",
    }, "record_changed", null, "11111111-1111-4111-8111-111111111111", { assertOwned: vi.fn() });

    expect(tx.execute).toHaveBeenCalledOnce();
    expect(tx.update).toHaveBeenCalledWith(endpointPools);
    expect(tx.update).toHaveBeenCalledWith(domainBindings);
    expect(inserts.find((insert) => insert.table === failoverEvents)?.values).toMatchObject({
      eventType: "dns_drift.record_changed",
    });
    expect(inserts.find((insert) => insert.table === reconcileIntents)?.values).toMatchObject({
      poolId: "22222222-2222-4222-8222-222222222222",
      decisionRevision: 12,
      policyRevision: 5,
      trigger: "repair",
      source: "drift",
    });
    expect(sequence).toEqual(["intent", "notification"]);
  });
});
