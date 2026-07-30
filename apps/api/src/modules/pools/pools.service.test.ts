import { ddnsAgents, endpointAddresses, endpointPools, endpoints, healthCheckConfigs, reconcileIntents } from "@masterdns/db";
import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import {
  buildManualHealthJobs,
  PoolsService,
  restoreEndpointPolicy,
  validateRestorablePolicySnapshot,
} from "./pools.service.js";

const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "admin",
  email: "admin@example.com",
  role: "admin" as const,
  sessionId: "44444444-4444-4444-8444-444444444444",
};
const poolId = "22222222-2222-4222-8222-222222222222";
const endpointId = "33333333-3333-4333-8333-333333333333";

describe("PoolsService DDNS to static conversion", () => {
  it("retires DDNS addresses, creates static addresses, and revokes the agent", async () => {
    const endpoint = { id: endpointId, poolId, addressMode: "ddns" as const, name: "edge" };
    const updateCalls: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const insertCalls: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const tx = createTransaction(endpoint, updateCalls, insertCalls);
    const database = { db: { transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) } };
    const service = new PoolsService(database as never, {} as never);
    vi.spyOn(service as any, "findOwnedPool").mockResolvedValue({ id: poolId });
    vi.spyOn(service as any, "findEndpoint").mockResolvedValue(endpoint);
    vi.spyOn(service as any, "recordPolicyChange").mockResolvedValue({});
    vi.spyOn(service as any, "enqueueReconcile").mockResolvedValue({ queued: true });

    await service.updateEndpoint(actor, poolId, endpointId, {
      addressMode: "static",
      ipv4: "192.0.2.40",
      forceApply: false,
    });

    expect(updateCalls.find((call) => call.table === endpointAddresses)?.values).toMatchObject({
      state: "previous",
    });
    expect(insertCalls).toEqual([
      expect.objectContaining({
        table: endpointAddresses,
        values: expect.objectContaining({ family: "4", address: "192.0.2.40", state: "current", source: "static" }),
      }),
    ]);
    expect(updateCalls.find((call) => call.table === ddnsAgents)?.values).toMatchObject({
      installTokenHash: null,
      installTokenExpiresAt: null,
      runtimeTokenHash: null,
      previousRuntimeTokenHash: null,
      previousRuntimeTokenExpiresAt: null,
      status: "disabled",
    });
    expect(updateCalls.find((call) => call.table === endpoints)?.values).toMatchObject({
      addressMode: "static",
      healthState: "unknown",
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      lastCheckedAt: null,
    });
  });

  it("still rejects direct address mutation while the endpoint remains DDNS", async () => {
    const endpoint = { id: endpointId, poolId, addressMode: "ddns" as const, name: "edge" };
    const tx = createTransaction(endpoint, [], []);
    const database = { db: { transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) } };
    const service = new PoolsService(database as never, {} as never);
    vi.spyOn(service as any, "findOwnedPool").mockResolvedValue({ id: poolId });
    vi.spyOn(service as any, "findEndpoint").mockResolvedValue(endpoint);

    await expect(service.updateEndpoint(actor, poolId, endpointId, {
      ipv4: "192.0.2.41",
      forceApply: false,
    })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("PoolsService policy rollback", () => {
  it("retires all DDNS active addresses before restoring static addresses", async () => {
    const restoredAt = new Date("2026-07-30T12:00:00.000Z");
    const updateCalls: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const insertCalls: Array<{ table: unknown; values: unknown }> = [];
    const tx = createRestoreTransaction("ddns", updateCalls, insertCalls);

    await restoreEndpointPolicy(tx as never, poolId, {
      id: endpointId,
      name: "edge",
      addressMode: "static",
      priority: 100,
      lifecycle: "enabled",
    }, [{
      endpointId,
      family: "4",
      address: "192.0.2.40",
      state: "current",
      source: "static",
    }], restoredAt);

    expect(updateCalls.find((call) => call.table === endpointAddresses)?.values).toMatchObject({
      state: "previous",
      healthState: "unknown",
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      lastCheckedAt: null,
    });
    expect(insertCalls).toContainEqual({
      table: endpointAddresses,
      values: [expect.objectContaining({ family: "4", address: "192.0.2.40", state: "current", source: "static" })],
    });
    expect(updateCalls.find((call) => call.table === ddnsAgents)?.values).toMatchObject({
      installTokenHash: null,
      runtimeTokenHash: null,
      previousRuntimeTokenHash: null,
      status: "disabled",
      revokedAt: restoredAt,
    });
    expect(updateCalls.find((call) => call.table === endpoints)?.values).toMatchObject({
      addressMode: "static",
      healthState: "unknown",
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      lastCheckedAt: null,
      stateChangedAt: restoredAt,
    });
  });

  it("retires static active addresses and credentials when restoring DDNS mode", async () => {
    const restoredAt = new Date("2026-07-30T12:00:00.000Z");
    const updateCalls: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const insertCalls: Array<{ table: unknown; values: unknown }> = [];
    const tx = createRestoreTransaction("static", updateCalls, insertCalls);

    await restoreEndpointPolicy(tx as never, poolId, {
      id: endpointId,
      name: "edge",
      addressMode: "ddns",
      priority: 100,
      lifecycle: "enabled",
    }, [{
      endpointId,
      family: "4",
      address: "198.51.100.8",
      state: "current",
      source: "ddns",
    }], restoredAt);

    expect(updateCalls.find((call) => call.table === endpointAddresses)?.values).toMatchObject({ state: "previous" });
    expect(updateCalls.find((call) => call.table === ddnsAgents)?.values).toMatchObject({
      installTokenHash: null,
      runtimeTokenHash: null,
      status: "disabled",
    });
    expect(updateCalls.find((call) => call.table === endpoints)?.values).toMatchObject({
      addressMode: "ddns",
      healthState: "unknown",
      lastCheckedAt: null,
    });
    expect(insertCalls).toEqual([]);
  });

  it("preserves DDNS active address rows while invalidating their health", async () => {
    const updateCalls: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const tx = createRestoreTransaction("ddns", updateCalls, []);

    await restoreEndpointPolicy(tx as never, poolId, {
      id: endpointId,
      name: "edge",
      addressMode: "ddns",
      priority: 100,
      lifecycle: "enabled",
    }, [], new Date("2026-07-30T12:00:00.000Z"));

    const addressReset = updateCalls.find((call) => call.table === endpointAddresses)?.values;
    expect(addressReset).toMatchObject({ healthState: "unknown", consecutiveSuccesses: 0, consecutiveFailures: 0, lastCheckedAt: null });
    expect(addressReset).not.toHaveProperty("state");
    expect(updateCalls.some((call) => call.table === ddnsAgents)).toBe(false);
  });

  it("rejects static snapshots without one valid static current address per family", () => {
    const snapshot = restorableSnapshot([{ endpointId, family: "4" as const, address: "192.0.2.40", state: "current" as const, source: "static" as const }]);
    expect(validateRestorablePolicySnapshot(snapshot, poolId).endpointIds).toEqual(new Set([endpointId]));
    expect(() => validateRestorablePolicySnapshot(restorableSnapshot([
      { endpointId, family: "4", address: "192.0.2.40", state: "current", source: "ddns" },
    ]), poolId)).toThrow(/静态地址/);
    expect(() => validateRestorablePolicySnapshot(restorableSnapshot([
      { endpointId, family: "4", address: "not-an-ip", state: "current", source: "static" },
    ]), poolId)).toThrow(/无效/);
  });
});

describe("PoolsService durable automation requests", () => {
  it("queues every current address for every effective manual health check", () => {
    expect(buildManualHealthJobs(endpointId, [{ id: "check-a" }, { id: "check-b" }], [
      { id: "ipv4-address" },
      { id: "ipv6-address" },
    ])).toEqual([
      { endpointId, configId: "check-a", addressId: "ipv4-address", manual: true },
      { endpointId, configId: "check-a", addressId: "ipv6-address", manual: true },
      { endpointId, configId: "check-b", addressId: "ipv4-address", manual: true },
      { endpointId, configId: "check-b", addressId: "ipv6-address", manual: true },
    ]);
  });

  it("includes addressId in every dual-stack manual health queue job", async () => {
    const database = {
      db: {
        select: vi.fn(() => ({
          from: vi.fn((table: unknown) => ({
            where: vi.fn(async () => table === healthCheckConfigs
              ? [
                { id: "check-a", endpointId, poolId: null },
                { id: "check-b", endpointId, poolId: null },
              ]
              : [{ id: "ipv4-address" }, { id: "ipv6-address" }]),
          })),
        })),
      },
    };
    const add = vi.fn(async (_name: string, _data: unknown, _options: unknown) => undefined);
    const service = new PoolsService(database as never, { health: { add } } as never);
    vi.spyOn(service as any, "findOwnedPool").mockResolvedValue({ id: poolId });
    vi.spyOn(service as any, "findEndpoint").mockResolvedValue({ id: endpointId, poolId });

    await expect(service.checkEndpoint(actor, poolId, endpointId)).resolves.toEqual({ queued: 4 });
    expect(add.mock.calls.map((call) => call[1])).toEqual([
      { endpointId, configId: "check-a", addressId: "ipv4-address", manual: true },
      { endpointId, configId: "check-a", addressId: "ipv6-address", manual: true },
      { endpointId, configId: "check-b", addressId: "ipv4-address", manual: true },
      { endpointId, configId: "check-b", addressId: "ipv6-address", manual: true },
    ]);
  });

  it("persists a user reconcile intent with the incremented decision revision", async () => {
    const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
    const tx = {
      execute: vi.fn(async () => undefined),
      update: vi.fn((table: unknown) => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => [{ decisionRevision: 8, policyRevision: 4 }]),
          })),
        })),
      })),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn(async (values: Record<string, unknown>) => {
          inserts.push({ table, values });
          return [];
        }),
      })),
    };
    const database = { db: { transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) } };
    const service = new PoolsService(database as never, {} as never);

    const result = await (service as any).enqueueReconcile(poolId, "rebalance", true);

    expect(tx.execute).toHaveBeenCalledOnce();
    expect(tx.update).toHaveBeenCalledWith(endpointPools);
    expect(inserts).toEqual([{
      table: reconcileIntents,
      values: expect.objectContaining({
        eventId: result.eventId,
        poolId,
        decisionRevision: 8,
        policyRevision: 4,
        trigger: "rebalance",
        source: "user",
        force: true,
      }),
    }]);
    expect(result).toMatchObject({ queued: true, decisionRevision: 8, policyRevision: 4 });
  });
});

function createTransaction(
  endpoint: { id: string; poolId: string; addressMode: "ddns"; name: string },
  updateCalls: Array<{ table: unknown; values: Record<string, unknown> }>,
  insertCalls: Array<{ table: unknown; values: Record<string, unknown> }>,
) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn(async () => table === endpoints ? [endpoint] : [{ id: "agent" }]),
          })),
        })),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateCalls.push({ table, values });
        return {
          where: vi.fn(() => table === endpoints
            ? { returning: vi.fn(async () => [{ ...endpoint, ...values }]) }
            : Promise.resolve([])),
        };
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: Record<string, unknown>) => {
        insertCalls.push({ table, values });
        return [];
      }),
    })),
  };
}

function createRestoreTransaction(
  currentMode: "static" | "ddns",
  updateCalls: Array<{ table: unknown; values: Record<string, unknown> }>,
  insertCalls: Array<{ table: unknown; values: unknown }>,
) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn(async () => table === endpoints
              ? [{ id: endpointId, addressMode: currentMode }]
              : [{ id: "agent" }]),
          })),
        })),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateCalls.push({ table, values });
        return { where: vi.fn(async () => []) };
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        insertCalls.push({ table, values });
        return [];
      }),
    })),
  };
}

function restorableSnapshot(addresses: Array<{
  endpointId: string;
  family: "4" | "6";
  address: string;
  state: "candidate" | "current" | "previous";
  source: "static" | "ddns";
}>) {
  return {
    pool: {
      name: "pool",
      description: null,
      strategy: "assignment_pool" as const,
      selectionMode: "ordered" as const,
      recoveryMode: "keep_current" as const,
      recoveryDelaySeconds: 0,
      failureThreshold: 3,
      successThreshold: 3,
      checkIntervalSeconds: 15,
      checkTimeoutMs: 3_000,
      switchCooldownSeconds: 300,
      allDownReminderSeconds: 1_800,
      enabled: true,
    },
    endpoints: [{ id: endpointId, name: "edge", addressMode: "static" as const, priority: 100, lifecycle: "enabled" as const }],
    addresses,
    bindings: [],
    healthChecks: [],
  };
}
