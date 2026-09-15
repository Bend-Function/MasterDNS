import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addressHealthPolicies,
  addressHealthStates,
  cloudAccounts,
  cloudEndpointLinks,
  cloudInstances,
  cloudInterfaces,
  createDatabase,
  endpoints,
  endpointPools,
  healthCheckConfigs,
  managedAddressSlots,
  notificationChannels,
  notificationDeliveries,
  poolNotificationChannels,
  rotationAttempts,
  rotationBudgetSegments,
  rotationIncidents,
  rotationPublications,
  rotationResources,
  rotationSteps,
  users,
} from "@masterdns/db";
import { eq } from "drizzle-orm";
import type { NotificationEvent } from "@masterdns/contracts";
import { Queue } from "bullmq";

vi.mock("../env.js", () => ({
  env: {
    MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    ALLOW_PRIVATE_WEBHOOK_TARGETS: false,
  },
}));

import { NotificationProcessor } from "./notification.processor.js";
import { NotificationStateScannerService } from "./notification-state-scanner.service.js";

let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
const databaseName = `notification_state_${randomUUID().replaceAll("-", "")}`;

beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  admin = createDatabase(root);
  await admin.client.unsafe(`create database "${databaseName}"`);
  const url = new URL(root);
  url.pathname = `/${databaseName}`;
  connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../packages/db/drizzle", import.meta.url).pathname });
});

afterAll(async () => {
  await connection?.close();
  if (admin) {
    await admin.client.unsafe(`drop database if exists "${databaseName}"`);
    await admin.close();
  }
});

beforeEach(async () => {
  await connection.client.unsafe("truncate table users cascade");
});

describe("durable notification state scanning", () => {
  it("keeps a confirmed after-threshold event stable across a lost wake and persists one delivery per channel", async () => {
    const fixture = await healthFixture({ decision: "failure", healthState: "unhealthy", consecutiveFailures: 4, failureThreshold: 3 });
    await insertChannel(fixture.ownerId, { isDefault: true });
    const firstWake = fakeQueues();
    const secondWake = fakeQueues();

    await new NotificationStateScannerService({ db: connection.db } as never, firstWake as never).scanOnce();
    await new NotificationStateScannerService({ db: connection.db } as never, secondWake as never).scanOnce();

    const first = firstWake.events[0]!;
    const second = secondWake.events[0]!;
    expect(first).toMatchObject({ eventType: "health.target_failed", ownerUserId: fixture.ownerId });
    expect(second.eventId).toBe(first.eventId);
    const processor = new NotificationProcessor({ db: connection.db } as never, fakeQueues() as never);
    await processor.fanout(first);
    await processor.fanout(second);
    expect(await connection.db.select().from(notificationDeliveries)).toHaveLength(1);
  });

  it("does not emit target failure or recovery before the current policy threshold", async () => {
    await healthFixture({ decision: "failure", healthState: "degraded", consecutiveFailures: 1, failureThreshold: 3 });
    await healthFixture({ decision: "success", healthState: "recovering", consecutiveSuccesses: 1, successThreshold: 3 });
    const queues = fakeQueues();

    await new NotificationStateScannerService({ db: connection.db } as never, queues as never).scanOnce();

    expect(queues.events).toEqual([]);
  });

  it("emits failure and recovery only after the current policy threshold is confirmed", async () => {
    await healthFixture({ decision: "failure", healthState: "unhealthy", consecutiveFailures: 3, failureThreshold: 3 });
    await healthFixture({ decision: "success", healthState: "healthy", consecutiveSuccesses: 3, successThreshold: 3 });
    const queues = fakeQueues();

    await new NotificationStateScannerService({ db: connection.db } as never, queues as never).scanOnce();

    expect(queues.events.map((event) => event.eventType).sort()).toEqual(["health.target_failed", "health.target_recovered"]);
  });

  it("keeps expired or insufficient evidence separate even when the historical state was unhealthy", async () => {
    await healthFixture({ decision: "unknown", healthState: "unhealthy", consecutiveFailures: 0 });
    const queues = fakeQueues();

    await new NotificationStateScannerService({ db: connection.db } as never, queues as never).scanOnce();

    expect(queues.events).toMatchObject([{ eventType: "health.insufficient_probes", payload: { decision: "unknown", healthState: "unhealthy" } }]);
  });

  it("enqueues a durable state event through actual BullMQ with a colon-free producer ID", async () => {
    const redisUrl = process.env.MASTERDNS_TEST_REDIS_URL;
    if (!redisUrl) throw new Error("MASTERDNS_TEST_REDIS_URL is required");
    await healthFixture({ decision: "failure", healthState: "unhealthy", consecutiveFailures: 3, failureThreshold: 3 });
    const url = new URL(redisUrl);
    const queue = new Queue(`p11c-notification-${randomUUID()}`, { connection: { host: url.hostname, port: Number(url.port) } });
    try {
      await new NotificationStateScannerService({ db: connection.db } as never, { notifications: queue } as never).scanOnce();
      const jobs = await queue.getJobs(["waiting", "delayed"]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.id).toMatch(/^fanout-state-/);
      expect(jobs[0]!.id).not.toContain(":");
      expect((jobs[0]!.data as { event: NotificationEvent }).event.eventId).toMatch(/^state:/);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("fans a shared-slot event out to owner defaults and all same-owner Pool channels only", async () => {
    const owner = await insertUser();
    const foreignOwner = await insertUser();
    const poolA = await insertPool(owner.id, "pool-a");
    const poolB = await insertPool(owner.id, "pool-b");
    const ownerDefault = await insertChannel(owner.id, { isDefault: true });
    const linkedA = await insertChannel(owner.id);
    const linkedB = await insertChannel(owner.id);
    const foreign = await insertChannel(foreignOwner.id);
    await connection.db.insert(poolNotificationChannels).values([
      { poolId: poolA.id, channelId: linkedA.id },
      { poolId: poolB.id, channelId: linkedB.id },
      { poolId: poolB.id, channelId: foreign.id },
    ]);
    const event: NotificationEvent = {
      eventId: "shared-slot-state",
      eventType: "health.insufficient_probes",
      ownerUserId: owner.id,
      poolIds: [poolA.id, poolB.id],
      occurredAt: new Date().toISOString(),
      payload: { summary: "Probe evidence is insufficient." },
    };

    await new NotificationProcessor({ db: connection.db } as never, fakeQueues() as never).fanout(event);

    const deliveries = await connection.db.select().from(notificationDeliveries);
    expect(deliveries.map((row) => row.channelId).sort()).toEqual([ownerDefault.id, linkedA.id, linkedB.id].sort());
    expect(deliveries.some((row) => row.channelId === foreign.id)).toBe(false);
  });

  it("applies default override per Pool before unioning shared-slot channels", async () => {
    const owner = await insertUser();
    const poolA = await insertPool(owner.id, "override-pool");
    const poolB = await insertPool(owner.id, "default-pool");
    const ownerDefault = await insertChannel(owner.id, { isDefault: true });
    const overriding = await insertChannel(owner.id);
    const linkedB = await insertChannel(owner.id);
    await connection.db.insert(poolNotificationChannels).values([
      { poolId: poolA.id, channelId: overriding.id, overridesDefaults: true },
      { poolId: poolB.id, channelId: linkedB.id },
    ]);
    const event: NotificationEvent = {
      eventId: "mixed-pool-override",
      eventType: "health.target_failed",
      ownerUserId: owner.id,
      poolIds: [poolA.id, poolB.id],
      occurredAt: new Date().toISOString(),
      payload: { summary: "Confirmed target failure." },
    };

    await new NotificationProcessor({ db: connection.db } as never, fakeQueues() as never).fanout(event);

    expect((await connection.db.select().from(notificationDeliveries)).map((row) => row.channelId).sort())
      .toEqual([ownerDefault.id, overriding.id, linkedB.id].sort());
  });

  it("emits whitelisted rotation state without cloud plans, headers, credentials, or snapshots", async () => {
    const fixture = await rotationFixture({ status: "paused", phase: "cloud", errorCode: "quota_exceeded" });
    const attemptId = randomUUID();
    await connection.db.insert(rotationAttempts).values({
      id: attemptId,
      incidentId: fixture.incidentId,
      segmentId: fixture.segmentId,
      sequence: 1,
      beforeInventory: { credential: "credential-value", headers: { authorization: "secret-header" } },
    });
    await connection.db.update(rotationIncidents).set({ currentAttemptId: attemptId }).where(eq(rotationIncidents.id, fixture.incidentId));
    await connection.db.insert(rotationSteps).values({
      id: `${attemptId}:0:test`,
      attemptId,
      sequence: 0,
      plan: { id: "test", action: "ec2.address.associate", resourceKey: "test", arguments: { token: "secret-token" }, destructive: false },
      errorCode: "quota_exceeded",
    });
    await connection.db.insert(rotationResources).values({
      incidentId: fixture.incidentId,
      attemptId,
      address: "192.0.2.10",
      role: "original",
      origin: "user",
      snapshot: { rawRequest: "do-not-leak" },
    });
    const queues = fakeQueues();

    await new NotificationStateScannerService({ db: connection.db } as never, queues as never).scanOnce();

    const event = queues.events.find((item) => item.payload.incidentId === fixture.incidentId)!;
    expect(event).toMatchObject({ eventType: "rotation.permission_or_quota", ownerUserId: fixture.ownerId });
    expect(JSON.stringify(event)).not.toMatch(/credential-value|secret-header|secret-token|do-not-leak|rawRequest|beforeInventory|plan/i);
  });

  it("advances through a full page so later health rows are eventually considered", async () => {
    const targetIds = [];
    for (let index = 0; index < 3; index += 1) targetIds.push((await healthFixture({ decision: "unknown", healthState: "unknown" })).stateId);
    const queues = fakeQueues();
    const scanner = new NotificationStateScannerService({ db: connection.db } as never, queues as never);

    await scanner.scanOnce(2);
    await scanner.scanOnce(2);

    const scanned = queues.events
      .filter((event) => event.eventType === "health.insufficient_probes")
      .map((event) => event.payload.healthStateId);
    expect(new Set(scanned)).toEqual(new Set(targetIds));
  });

  it("announces cleanup completion once all tracked resources are settled", async () => {
    const fixture = await rotationFixture({ status: "active", phase: "cleanup" });
    const attemptId = randomUUID();
    await connection.db.insert(rotationAttempts).values({
      id: attemptId,
      incidentId: fixture.incidentId,
      segmentId: fixture.segmentId,
      sequence: 1,
      beforeInventory: {},
    });
    await connection.db.update(rotationIncidents).set({ currentAttemptId: attemptId }).where(eq(rotationIncidents.id, fixture.incidentId));
    await connection.db.insert(rotationResources).values([
      { incidentId: fixture.incidentId, attemptId, address: "192.0.2.10", role: "original", origin: "user", snapshot: {}, cleanupStatus: "retained" },
      { incidentId: fixture.incidentId, attemptId, address: "192.0.2.11", role: "candidate", origin: "system", snapshot: {}, cleanupStatus: "released" },
    ]);
    const queues = fakeQueues();

    await new NotificationStateScannerService({ db: connection.db } as never, queues as never).scanOnce();

    expect(queues.events.find((event) => event.payload.incidentId === fixture.incidentId)?.eventType).toBe("rotation.cleanup_completed");
  });
});

async function healthFixture(input: {
  decision: "success" | "failure" | "unknown";
  healthState: "unknown" | "healthy" | "unhealthy" | "degraded" | "recovering";
  consecutiveSuccesses?: number;
  consecutiveFailures?: number;
  successThreshold?: number;
  failureThreshold?: number;
}) {
  const owner = await insertUser();
  const pool = await insertPool(owner.id, randomUUID());
  const [endpoint] = await connection.db.insert(endpoints).values({ poolId: pool.id, name: "target" }).returning();
  const [config] = await connection.db.insert(healthCheckConfigs).values({
    endpointId: endpoint!.id,
    checkerType: "tcp",
    config: { type: "tcp", port: 443, timeoutMs: 3000 },
  }).returning();
  const [policy] = await connection.db.insert(addressHealthPolicies).values({
    endpointId: endpoint!.id,
    family: "4",
    configId: config!.id,
    successThreshold: input.successThreshold ?? 3,
    failureThreshold: input.failureThreshold ?? 3,
  }).returning();
  const changedAt = new Date("2026-09-15T01:02:03.000Z");
  const [state] = await connection.db.insert(addressHealthStates).values({
    endpointId: endpoint!.id,
    family: "4",
    configId: config!.id,
    configVersion: config!.revision,
    policyId: policy!.id,
    policyRevision: policy!.revision,
    latestDecision: input.decision,
    healthState: input.healthState,
    consecutiveSuccesses: input.consecutiveSuccesses ?? 0,
    consecutiveFailures: input.consecutiveFailures ?? 0,
    stateChangedAt: changedAt,
  }).returning();
  return { ownerId: owner.id, poolId: pool.id, stateId: state!.id };
}

async function rotationFixture(input: { status: "active" | "paused" | "exhausted" | "complete"; phase: "cloud" | "candidate" | "publish" | "cleanup" | "complete"; errorCode?: string }) {
  const owner = await insertUser();
  const [account] = await connection.db.insert(cloudAccounts).values({
    ownerUserId: owner.id,
    provider: "aws",
    name: "AWS",
    credentialCiphertext: "encrypted",
    credentialIv: "iv",
    credentialTag: "tag",
  }).returning();
  const [instance] = await connection.db.insert(cloudInstances).values({ accountId: account!.id, service: "ec2", region: "us-east-1", externalId: randomUUID(), scanGeneration: 1 }).returning();
  const [iface] = await connection.db.insert(cloudInterfaces).values({ instanceId: instance!.id, externalId: randomUUID(), scanGeneration: 1 }).returning();
  const [slot] = await connection.db.insert(managedAddressSlots).values({ interfaceId: iface!.id, family: "4", name: "public" }).returning();
  const segmentId = randomUUID();
  const [incident] = await connection.db.insert(rotationIncidents).values({
    ownerUserId: owner.id,
    slotId: slot!.id,
    family: "4",
    physicalKey: randomUUID(),
    sourceEventId: randomUUID(),
    status: input.status,
    phase: input.phase,
    currentSegmentId: segmentId,
    authorizationRevision: 1,
    policyRevision: 1,
    addressVersion: 1,
    healthPolicyId: randomUUID(),
    healthPolicyRevision: 1,
    configId: randomUUID(),
    configRevision: 1,
    groupId: randomUUID(),
    groupRevision: 1,
    errorCode: input.errorCode,
  }).returning();
  await connection.db.insert(rotationBudgetSegments).values({ id: segmentId, incidentId: incident!.id, maxAttempts: 3 });
  return { ownerId: owner.id, incidentId: incident!.id, segmentId };
}

async function insertUser() {
  const [row] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  return row!;
}

async function insertPool(ownerUserId: string, name: string) {
  const [row] = await connection.db.insert(endpointPools).values({ ownerUserId, name, strategy: "primary_backup" }).returning();
  return row!;
}

async function insertChannel(ownerUserId: string, input: { isDefault?: boolean } = {}) {
  const [row] = await connection.db.insert(notificationChannels).values({
    ownerUserId,
    type: "webhook",
    name: randomUUID(),
    endpoint: "https://example.test/webhook",
    secretCiphertext: "encrypted",
    secretIv: "iv",
    secretTag: "tag",
    isDefault: input.isDefault ?? false,
  }).returning();
  return row!;
}

function fakeQueues() {
  const events: NotificationEvent[] = [];
  return {
    events,
    notifications: {
      add: vi.fn(async (_name: string, job: { kind: string; event?: NotificationEvent }) => {
        if (job.kind === "fanout" && job.event) events.push(job.event);
        return {};
      }),
    },
  };
}
