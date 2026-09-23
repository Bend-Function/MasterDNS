import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DnsRecordInput, OperationJob, PoolReconcileJob, ProviderRecord } from "@masterdns/contracts";
import * as db from "@masterdns/db";
import { ProbeLeasesService } from "../src/modules/probes/probe-leases.service.js";
import { ProbeResultsService } from "../src/modules/probes/probe-results.service.js";
import { fixture, testDatabase } from "../../worker/src/probes/probe-test-utils.js";
import { ProbeSchedulerService } from "../../worker/src/probes/probe-scheduler.service.js";
import { ProbeHealthService } from "../../worker/src/probes/probe-health.service.js";
import { HealthResultService } from "../../worker/src/health/health-result.service.js";
import { ReconcileOutboxService } from "../../worker/src/automation/reconcile-outbox.service.js";
import { ReconcileProcessor } from "../../worker/src/automation/reconcile.processor.js";
import { OperationProcessor } from "../../worker/src/operations/operation.processor.js";

let connection: Awaited<ReturnType<typeof testDatabase>>;
let redis: Redis;
beforeAll(async () => {
  connection = await testDatabase();
  redis = new Redis(process.env.MASTERDNS_TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  await redis.ping();
}, 30_000);
afterAll(async () => {
  await redis?.quit();
  await connection?.dispose();
});

it.each(["external", "mixed"] as const)("fails over published DDNS through %s probe consensus while isolating candidate and late address evidence", async mode => {
  const d = connection.db;
  const database = { db: d } as never;
  const f = await fixture(d, "ddns");
  // Establish both usable addresses through the real probe pipeline, not seeded health.
  await d.update(db.endpointAddresses).set({ state: "current" }).where(eq(db.endpointAddresses.id, f.address.id));
  await d.update(db.endpoints).set({ priority: 10 }).where(eq(db.endpoints.id, f.endpoint.id));
  await d.update(db.endpointPools).set({ switchCooldownSeconds: 0 }).where(eq(db.endpointPools.id, f.pool.id));
  const [backup] = await d.insert(db.endpoints).values({ poolId: f.pool.id, name: "backup", priority: 20 }).returning();
  const [backupAddress] = await d.insert(db.endpointAddresses).values({ endpointId: backup!.id, family: "4", address: "192.0.2.2", source: "static", state: "current" }).returning();
  const [backupConfig] = await d.insert(db.healthCheckConfigs).values({ endpointId: backup!.id, checkerType: "tcp", config: f.config.config }).returning();
  const policies = await d.insert(db.addressHealthPolicies).values([
    { endpointId: f.endpoint.id, configId: f.config.id },
    { endpointId: backup!.id, configId: backupConfig!.id },
  ].map(target => ({ ...target, family: "4" as const, mode, groupId: f.group.id, consensus: { mode: "all" as const, minimumValid: mode === "mixed" ? 3 : 2 }, successThreshold: 2, failureThreshold: 2 }))).returning();
  const [account] = await d.insert(db.providerAccounts).values({ ownerUserId: f.actor.id, provider: "cloudflare", name: "DNS", credentialCiphertext: "test", credentialIv: "test", credentialTag: "test", status: "active" }).returning();
  const [zone] = await d.insert(db.zones).values({ providerAccountId: account!.id, externalId: randomUUID(), nameAscii: "ddns.test" }).returning();
  const [binding] = await d.insert(db.domainBindings).values({ poolId: f.pool.id, zoneId: zone!.id, fqdn: "www.ddns.test", recordType: "A", originalEndpointId: f.endpoint.id }).returning();

  const health = new ProbeHealthService(database, new HealthResultService(database));
  const scheduler = new ProbeSchedulerService(database, health);
  const leases = new ProbeLeasesService(database);
  const results = new ProbeResultsService(database);
  const queueOptions = { connection: redis, prefix: `ddns-test-${randomUUID()}` };
  const queues = {
    redis,
    reconcile: new Queue<PoolReconcileJob>("reconcile", queueOptions),
    operations: new Queue<OperationJob>("operations", queueOptions),
    notifications: new Queue("notifications", queueOptions),
  };
  const runtime = queues as never;
  const outbox = new ReconcileOutboxService(database, runtime);
  const reconcile = new ReconcileProcessor(database, runtime);
  const remote = new Map<string, ProviderRecord>();
  const writes: string[] = [];
  const write = (zoneExternalId: string, externalId: string, record: DnsRecordInput) => {
    expect(zoneExternalId).toBe(zone!.externalId);
    writes.push(record.content);
    const saved = { ...record, externalId, zoneExternalId };
    remote.set(externalId, saved);
    return saved;
  };
  // Only the external DNS provider is replaced; health, persistence, queueing,
  // Redis leases, reconciliation, operation execution and read-back are real.
  const operations = new OperationProcessor(database, runtime, { forAccount: async () => ({ adapter: {
    provider: "cloudflare",
    listRecords: async () => ({ items: [...remote.values()] }),
    getRecord: async (_zone: string, id: string) => remote.get(id) ?? null,
    createRecord: async (zoneId: string, record: DnsRecordInput) => write(zoneId, randomUUID(), record),
    updateRecord: async (zoneId: string, id: string, record: DnsRecordInput) => {
      expect(remote.has(id)).toBe(true);
      return write(zoneId, id, record);
    },
  } }) } as never);

  async function reconcilePending() {
    await outbox["dispatchPending"]();
    for (const job of await queues.reconcile.getWaiting()) {
      await reconcile["process"](job);
      await job.remove();
    }
    for (const job of await queues.operations.getWaiting()) {
      await operations["process"](job);
      const [operation] = await d.select().from(db.operations).where(eq(db.operations.id, job.data.operationId));
      expect(operation!.status).toBe("succeeded");
      await job.remove();
    }
    expect(await d.select().from(db.reconcileIntents).where(and(eq(db.reconcileIntents.poolId, f.pool.id), isNull(db.reconcileIntents.completedAt)))).toEqual([]);
  }
  async function assertDns(address: string, endpointId: string) {
    expect([...remote.values()]).toMatchObject([{ content: address, name: binding!.fqdn, type: "A" }]);
    expect(await d.select().from(db.dnsRecords).where(eq(db.dnsRecords.zoneId, zone!.id))).toMatchObject([{ content: address, management: "managed", managedByPoolId: f.pool.id }]);
    expect(await d.select().from(db.bindingAssignments).where(and(eq(db.bindingAssignments.domainBindingId, binding!.id), eq(db.bindingAssignments.applied, true)))).toMatchObject([{ endpointId, desired: true }]);
  }
  const base = new Date("2026-09-20T00:00:00Z");
  async function observedRounds(tick: number, outcomes: Map<string, "success" | "failure">) {
    const now = new Date(base.getTime() + tick * 15_000);
    for (const agent of f.agents) await d.update(db.probeAgents).set({ lastSeenAt: now }).where(eq(db.probeAgents.id, agent.id));
    for (const policy of policies) await scheduler.schedulePolicy(policy.id, now);
    const rounds = (await d.select().from(db.probeRounds).where(eq(db.probeRounds.status, "pending"))).filter(round => round.endpointId === f.endpoint.id || round.endpointId === backup!.id);
    expect(rounds.map(round => round.endpointAddressId).sort()).toEqual([...outcomes.keys()].sort());
    // Lease and accept through the API services, exercising immutable task IDs
    // and address epochs instead of inserting accepted observations directly.
    for (const agent of f.agents) {
      const tasks = await leases.lease(agent.id, 16, new Date(now.getTime() + 1));
      expect(tasks).toHaveLength(rounds.length);
      for (const task of tasks) {
        const round = rounds.find(item => item.id === task.roundId)!;
        expect(await results.accept(agent.id, {
          protocol: "probe-agent/v1", taskId: task.taskId, leaseId: task.leaseId,
          addressVersion: task.addressVersion, configVersion: task.configVersion,
          outcome: outcomes.get(round.endpointAddressId!)!, latencyMs: 2, measuredAt: now.toISOString(),
        }, new Date(now.getTime() + 2))).toBe("accepted");
      }
    }
    if (mode === "mixed") for (const round of rounds) {
      expect(await health.recordLocal(round.id, outcomes.get(round.endpointAddressId!)!, new Date(now.getTime() + 3))).toBe(true);
    }
    return rounds;
  }
  const getAddress = async (id: string) => (await d.select().from(db.endpointAddresses).where(eq(db.endpointAddresses.id, id)))[0]!;
  const getState = async (id: string) => (await d.select().from(db.addressHealthStates).where(eq(db.addressHealthStates.addressId, id)))[0]!;

  try {
    for (let tick = 0; tick < 2; tick++) {
      for (const round of await observedRounds(tick, new Map([[f.address.id, "success"], [backupAddress!.id, "success"]]))) {
        expect(await health.closeRound(round.id, round.deadline)).toBe("success");
      }
    }
    expect(await getAddress(f.address.id)).toMatchObject({ healthState: "healthy", consecutiveSuccesses: 2 });
    expect(await getAddress(backupAddress!.id)).toMatchObject({ healthState: "healthy", consecutiveSuccesses: 2 });
    await reconcilePending();
    await assertDns(f.address.address, f.endpoint.id);
    expect(writes).toEqual([f.address.address]);

    const [candidate] = await d.insert(db.endpointAddresses).values({ endpointId: f.endpoint.id, family: "4", address: "192.0.2.3", state: "candidate", source: "ddns" }).returning();
    for (let tick = 2; tick < 4; tick++) {
      const rounds = await observedRounds(tick, new Map([[f.address.id, "failure"], [candidate!.id, "failure"], [backupAddress!.id, "success"]]));
      const currentRound = rounds.find(round => round.endpointAddressId === f.address.id)!;
      const candidateRound = rounds.find(round => round.endpointAddressId === candidate!.id)!;
      expect(candidateRound.sequence).toBeGreaterThan(currentRound.sequence);
      // The newer candidate sequence must not suppress its published sibling.
      rounds.sort((a, b) => Number(b.endpointAddressId === candidate!.id) - Number(a.endpointAddressId === candidate!.id));
      for (const round of rounds) await health.closeRound(round.id, round.deadline);
      if (tick === 2) {
        expect(await getState(f.address.id)).toMatchObject({ consecutiveFailures: 1 });
        expect(await getState(candidate!.id)).toMatchObject({ consecutiveFailures: 1 });
        await reconcilePending();
        await assertDns(f.address.address, f.endpoint.id);
        expect(writes).toEqual([f.address.address]);
      }
    }
    expect(await getAddress(f.address.id)).toMatchObject({ state: "current", healthState: "unhealthy", consecutiveFailures: 2 });
    expect(await getAddress(candidate!.id)).toMatchObject({ state: "candidate", healthState: "unhealthy", consecutiveFailures: 2 });
    expect((await d.select().from(db.endpoints).where(eq(db.endpoints.id, f.endpoint.id)))[0]!.healthState).toBe("unhealthy");
    expect(await getState(backupAddress!.id)).toMatchObject({ healthState: "healthy", consecutiveSuccesses: 4 });
    const pending = await d.select().from(db.reconcileIntents).where(and(eq(db.reconcileIntents.poolId, f.pool.id), isNull(db.reconcileIntents.completedAt)));
    expect(pending).toMatchObject([{ trigger: "failure", source: "failover", endpointId: f.endpoint.id }]);
    await reconcilePending();
    await assertDns(backupAddress!.address, backup!.id);
    expect(writes).toEqual([f.address.address, backupAddress!.address]);

    for (let tick = 4; tick < 6; tick++) {
      const rounds = await observedRounds(tick, new Map([[f.address.id, "failure"], [candidate!.id, "success"], [backupAddress!.id, "success"]]));
      const candidateRound = rounds.find(round => round.endpointAddressId === candidate!.id)!;
      await health.closeRound(candidateRound.id, candidateRound.deadline);
      for (const round of rounds.filter(item => item.id !== candidateRound.id)) {
        const decision = await health.closeRound(round.id, round.deadline);
        if (tick === 5 && round.endpointAddressId === f.address.id) {
          expect(decision).toBe("unknown");
          expect((await d.select().from(db.probeRounds).where(eq(db.probeRounds.id, round.id)))[0]!.status).toBe("superseded");
        }
      }
      if (tick === 4) {
        expect(await getAddress(candidate!.id)).toMatchObject({ state: "candidate", consecutiveSuccesses: 1, consecutiveFailures: 0 });
        await reconcilePending();
        await assertDns(backupAddress!.address, backup!.id);
        expect(writes).not.toContain(candidate!.address);
      }
    }
    expect(await getAddress(candidate!.id)).toMatchObject({ state: "current", healthState: "healthy", consecutiveSuccesses: 2, consecutiveFailures: 0 });
    expect(await getAddress(f.address.id)).toMatchObject({ state: "previous", healthState: "unhealthy", consecutiveFailures: 3 });
    expect(await getState(candidate!.id)).toMatchObject({ healthState: "healthy", consecutiveSuccesses: 2, consecutiveFailures: 0 });
    expect(await getState(f.address.id)).toMatchObject({ healthState: "unhealthy", consecutiveFailures: 3 });
    expect(await d.select().from(db.addressHealthStates).where(eq(db.addressHealthStates.endpointId, f.endpoint.id))).toHaveLength(2);
    expect((await d.select().from(db.endpoints).where(eq(db.endpoints.id, f.endpoint.id)))[0]).toMatchObject({ healthState: "healthy", consecutiveSuccesses: 2, consecutiveFailures: 0 });
    await reconcilePending();
    await assertDns(backupAddress!.address, backup!.id);
    expect(writes).toEqual([f.address.address, backupAddress!.address]);
  } finally {
    for (const queue of [queues.reconcile, queues.operations, queues.notifications]) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }
}, 30_000);
