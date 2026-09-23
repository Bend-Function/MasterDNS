import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import * as db from "@masterdns/db";
vi.mock("../env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { effectiveOldTtl, RotationPublicationService } from "./rotation-publication.service.js";
import { fixture } from "./rotation-test-utils.js";
import { terminateRotationIncident } from "@masterdns/db";
it("publishes initial verified candidates to all linked Pools with both auto switches off and no incident or rotation policy", async () => {
  const f = await fixture();
  for (const pool of f.pools) await f.d.update(db.endpointPools).set({ state: "unhealthy" }).where(eq(db.endpointPools.id, pool.id));
  await f.service.recover();
  for (const pool of f.pools) expect((await f.d.select().from(db.endpointPools).where(eq(db.endpointPools.id, pool.id)))[0]!.state).toBe("healthy");
  expect(await f.d.select().from(db.rotationIncidents)).toHaveLength(0);
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]).toMatchObject({
    currentVersion: 1,
    candidateAddressId: null,
  });
  expect(await f.d.select().from(db.endpointAddresses)).toHaveLength(2);
  expect(await f.d.select().from(db.reconcileIntents)).toHaveLength(2);
  expect((await f.d.select().from(db.rotationPublications))[0]).toMatchObject({ incidentId: null, status: "in_flight" });
  await f.service.recover();
  expect(await f.d.select().from(db.reconcileIntents)).toHaveLength(2);
});
it("does not publish stale evidence or a cloud address absent from fresh provider inspection", async () => {
  const f = await fixture();
  f.live.interfaces[0]!.addresses[0]!.address = "192.0.2.99";
  await f.service.recover();
  expect(await f.d.select().from(db.endpointAddresses).where(eq(db.endpointAddresses.endpointId, f.endpoints[0]!.id))).toHaveLength(0);
  f.live.interfaces[0]!.addresses[0]!.address = f.address.address;
  await f.d.update(db.addressHealthStates).set({ consecutiveSuccesses: 1 }).where(eq(db.addressHealthStates.slotId, f.slot.id));
  await f.service.recover();
  expect(await f.d.select().from(db.endpointAddresses).where(eq(db.endpointAddresses.endpointId, f.endpoints[0]!.id))).toHaveLength(0);
});
async function advanceInventory(f: Awaited<ReturnType<typeof fixture>>, generation: number) {
  await f.d.transaction(async tx => {
    await tx.update(db.cloudScanScopes).set({ generation, lastCompletedAt: new Date() }).where(eq(db.cloudScanScopes.accountId, f.account.id));
    await tx.update(db.cloudInstances).set({ scanGeneration: generation }).where(eq(db.cloudInstances.id, f.instance.id));
    await tx.update(db.cloudInterfaces).set({ scanGeneration: generation }).where(eq(db.cloudInterfaces.id, f.slot.interfaceId));
  });
}
it("keeps a verified promoted candidate current until a later successful inventory omits it", async () => {
  const f = await fixture();
  await f.d.update(db.instanceAuthorizations).set({ allowIpv4Rotation: true }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  await f.d.insert(db.rotationPolicies).values({ slotId: f.slot.id, enabled: true });
  const segmentId = randomUUID(), attemptId = randomUUID();
  const [incident] = await f.d.insert(db.rotationIncidents).values({
    ownerUserId: f.account.ownerUserId, slotId: f.slot.id, family: "4", phase: "publish", currentSegmentId: segmentId, currentAttemptId: attemptId,
    physicalKey: JSON.stringify(["aws", f.account.externalAccountId, "ec2", "us-east-1", f.instance.externalId]), sourceEventId: randomUUID(),
    authorizationRevision: 1, policyRevision: 1, addressVersion: 1, healthPolicyId: f.policy.id, healthPolicyRevision: 1,
    configId: f.policy.configId, configRevision: 1, groupId: f.policy.groupId!, groupRevision: 1,
  }).returning();
  await f.d.insert(db.rotationBudgetSegments).values({ id: segmentId, incidentId: incident!.id, maxAttempts: 3 });
  await f.d.insert(db.rotationAttempts).values({ id: attemptId, incidentId: incident!.id, segmentId, sequence: 1, beforeInventory: f.live, status: "verified", candidateAddressId: f.address.id, candidateVersion: 1 });
  await f.d.insert(db.rotationPublications).values({ slotId: f.slot.id, incidentId: incident!.id, addressId: f.address.id, addressVersion: 1 });
  const [agent] = await f.d.insert(db.probeAgents).values({ ownerUserId: f.account.ownerUserId, name: "external", capabilities: { ipv4: true, ipv6: true } }).returning();
  await f.d.insert(db.probeGroupMembers).values({ groupId: f.policy.groupId!, probeId: agent!.id });
  await advanceInventory(f, 2);
  expect((await db.getCloudTargetsForSlots(f.d, [f.slot.id])).get(f.slot.id)).toMatchObject({ inventoryCurrent: false, activeCandidate: true, available: true });
  await f.service.publishSlot(f.slot.id, incident!.id);
  expect((await db.getCloudTargetsForSlots(f.d, [f.slot.id])).get(f.slot.id)).toMatchObject({ inventoryCurrent: true, activeCandidate: false, available: true, candidateAddress: null });
  expect((await f.d.select().from(db.cloudAddresses).where(eq(db.cloudAddresses.id, f.address.id)))[0]).toMatchObject({ scanGeneration: 2, origin: f.address.origin, remoteAllocationId: f.address.remoteAllocationId, metadata: f.address.metadata });
  const database = { db: f.d } as never;
  const scheduler = new ProbeSchedulerService(database, new ProbeHealthService(database, new HealthResultService(database)));
  expect(await scheduler.schedulePolicy(f.policy.id)).toMatchObject({ address: f.address.address, addressVersion: 1 });
  expect((await f.d.select().from(db.addressHealthStates).where(eq(db.addressHealthStates.slotId, f.slot.id)))[0]).toMatchObject({ latestDecision: "success", healthState: "healthy" });
  await advanceInventory(f, 3);
  expect((await db.getCloudTargetsForSlots(f.d, [f.slot.id])).get(f.slot.id)).toMatchObject({ inventoryCurrent: false, activeCandidate: false, available: false });
  expect(await scheduler.schedulePolicy(f.policy.id)).toBeUndefined();
  expect((await f.d.select().from(db.addressHealthStates).where(eq(db.addressHealthStates.slotId, f.slot.id)))[0]).toMatchObject({ latestDecision: "unknown", healthState: "unknown" });
});
it("does not refresh address presence from an inspection preceding a newer inventory", async () => {
  const f = await fixture();
  const service = new RotationPublicationService({ db: f.d } as never, { adapter: async () => ({ inspect: async () => {
    const live = structuredClone(f.live);
    await advanceInventory(f, 2);
    return live;
  } }) } as never);
  await expect(service.publishSlot(f.slot.id)).rejects.toThrow("live_cloud_address_changed");
  expect((await f.d.select().from(db.cloudAddresses).where(eq(db.cloudAddresses.id, f.address.id)))[0]!.scanGeneration).toBe(1);
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]).toMatchObject({ currentVersion: 0, candidateAddressId: f.address.id });
});
it("requires a DNS link for initial verification without a rotation incident", async () => {
  const f = await fixture();
  await f.d.delete(db.cloudEndpointLinks).where(eq(db.cloudEndpointLinks.slotId, f.slot.id));
  await expect(f.service.publishSlot(f.slot.id)).rejects.toThrow("publication_has_no_links");
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]).toMatchObject({ currentVersion: 0, candidateAddressId: f.address.id });
});
it("normalizes Cloudflare automatic TTL and retains an unknown automatic sentinel conservatively", () => {
  expect(effectiveOldTtl(1, "cloudflare")).toBe(300);
  expect(effectiveOldTtl(1, "unknown")).toBe(86400);
  expect(effectiveOldTtl(600, "cloudflare")).toBe(600);
});

import { Redis } from "ioredis";
import { beforeAll, afterAll } from "vitest";
import { ProviderError, type DnsRecordInput, type ProviderRecord } from "@masterdns/contracts";
import { ReconcileProcessor } from "../automation/reconcile.processor.js";
import { OperationProcessor } from "../operations/operation.processor.js";
let redis: Redis;
beforeAll(async () => {
  redis = new Redis(process.env.MASTERDNS_TEST_REDIS_URL ?? "redis://127.0.0.1:56379", { maxRetriesPerRequest: null });
  await redis.ping();
});
afterAll(async () => {
  await redis?.quit();
});
async function dnsFixture(backup = false) {
  const f = await fixture();
  const writes: string[] = [];
  const remote = new Map<string, ProviderRecord>();
  const dnsAccounts: Array<typeof db.providerAccounts.$inferSelect> = [];
  const bindings = [];
  for (let n = 0; n < 2; n++) {
    const [account] = await f.d
      .insert(db.providerAccounts)
      .values({
        ownerUserId: f.account.ownerUserId,
        provider: n === 0 ? "cloudflare" : "aliyun",
        name: `dns${n}`,
        credentialCiphertext: "test",
        credentialIv: "iv",
        credentialTag: "tag",
        status: "active",
      })
      .returning();
    dnsAccounts.push(account!);
    const [zone] = await f.d
      .insert(db.zones)
      .values({ providerAccountId: account!.id, externalId: `zone-${n}`, nameAscii: `zone-${n}.test` })
      .returning();
    const [binding] = await f.d
      .insert(db.domainBindings)
      .values({
        poolId: f.pools[n]!.id,
        zoneId: zone!.id,
        fqdn: `www.zone-${n}.test`,
        recordType: "A",
        originalEndpointId: f.endpoints[n]!.id,
        ttl: 60,
      })
      .returning();
    bindings.push(binding!);
    if (backup && n === 1) {
      const [endpoint] = await f.d
        .insert(db.endpoints)
        .values({ poolId: f.pools[n]!.id, name: "backup", addressMode: "static", healthState: "healthy", priority: 200 })
        .returning();
      await f.d.insert(db.endpointAddresses).values({
        endpointId: endpoint!.id,
        family: "4",
        address: "192.0.2.88",
        source: "static",
        state: "current",
        healthState: "healthy",
      });
      const record = {
        externalId: "backup-record",
        zoneExternalId: `zone-${n}`,
        type: "A" as const,
        name: binding!.fqdn,
        content: "192.0.2.88",
        ttl: 60,
        providerMetadata: {},
      };
      remote.set(`zone-${n}`, record);
      const [cached] = await f.d
        .insert(db.dnsRecords)
        .values({ ...record, zoneId: zone!.id, management: "managed", managedByPoolId: f.pools[n]!.id, remoteHash: "cached" })
        .returning();
      await f.d.insert(db.bindingAssignments).values({
        domainBindingId: binding!.id,
        endpointId: endpoint!.id,
        dnsRecordId: cached!.id,
        applied: true,
        desired: true,
        reason: "backup",
      });
    }
  }
  const state = { failSecond: true, cloudCalls: 0 };
  const cloudRuntime = {
    adapter: async () => ({
      inspect: async () => f.live,
      execute: async () => {
        state.cloudCalls++;
        throw new Error("publication_must_not_allocate");
      },
    }),
  };
  const notifications = vi.fn(async () => ({}));
  const queues = { redis, operations: { add: async () => ({}) }, notifications: { add: notifications } };
  const reconcile = new ReconcileProcessor({ db: f.d } as never, queues as never);
  const operations = new OperationProcessor(
    { db: f.d } as never,
    queues as never,
    {
      forAccount: async (id: string) => ({
        adapter: {
          provider: dnsAccounts.find((a) => a.id === id)!.provider,
          listRecords: async (zone: string) => ({ items: remote.has(zone) ? [remote.get(zone)!] : [] }),
          getRecord: async (zone: string) => remote.get(zone) ?? null,
          createRecord: async (zone: string, input: DnsRecordInput) => {
            if (state.failSecond && zone === "zone-1") throw new ProviderError("fake DNS failure", "transient_failure", "aliyun");
            writes.push(zone);
            const r = { ...input, externalId: `record-${zone}`, zoneExternalId: zone };
            remote.set(zone, r);
            return r;
          },
          updateRecord: async (zone: string, _id: string, input: DnsRecordInput) => {
            if (state.failSecond && zone === "zone-1") throw new ProviderError("fake DNS failure", "transient_failure", "aliyun");
            writes.push(zone);
            const r = { ...input, externalId: `record-${zone}`, zoneExternalId: zone };
            remote.set(zone, r);
            return r;
          },
        },
      }),
    } as never,
    cloudRuntime as never,
  );
  const plan = async () => {
    const intents = await f.d.select().from(db.reconcileIntents).where(eq(db.reconcileIntents.poolId, f.pools[0]!.id));
    intents.push(...(await f.d.select().from(db.reconcileIntents).where(eq(db.reconcileIntents.poolId, f.pools[1]!.id))));
    for (const intent of intents) await (reconcile as any).process({ data: intent });
  };
  const execute = async () => {
    for (const pool of f.pools) {
      const ops = await f.d.select().from(db.operations).where(eq(db.operations.resourceId, pool.id));
      for (const op of ops) await (operations as any).process({ data: { operationId: op.id }, attemptsMade: 0, opts: { attempts: 1 } });
    }
  };
  return { ...f, writes, state, bindings, plan, execute, remote, reconcile, notifications };
}

it("keeps initial cloud verification pending without a false outage notification", async () => {
  const f = await dnsFixture();
  await (f.reconcile as any).process({ data: { poolId: f.pools[0]!.id, eventId: randomUUID(), trigger: "configuration", force: false } });
  expect((await f.d.select().from(db.endpointPools).where(eq(db.endpointPools.id, f.pools[0]!.id)))[0]!.state).toBe("unknown");
  expect(f.notifications).not.toHaveBeenCalled();
  expect(await f.d.select().from(db.operations).where(eq(db.operations.resourceId, f.pools[0]!.id))).toEqual([]);
  expect(await f.d.select().from(db.failoverEvents).where(eq(db.failoverEvents.poolId, f.pools[0]!.id))).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "pool.awaiting_verification" })]));
  await f.service.publishSlot(f.slot.id);
  expect((await f.d.select().from(db.endpointPools).where(eq(db.endpointPools.id, f.pools[0]!.id)))[0]!.state).toBe("healthy");
});

it("still reports a real outage for an already published cloud binding", async () => {
  const f = await dnsFixture();
  await f.service.publishSlot(f.slot.id); await f.plan(); await f.execute();
  f.notifications.mockClear();
  await f.d.update(db.endpointAddresses).set({ healthState: "unhealthy" }).where(eq(db.endpointAddresses.endpointId, f.endpoints[0]!.id));
  await (f.reconcile as any).process({ data: { poolId: f.pools[0]!.id, eventId: randomUUID(), trigger: "failure", force: false } });
  expect((await f.d.select().from(db.endpointPools).where(eq(db.endpointPools.id, f.pools[0]!.id)))[0]!.state).toBe("unhealthy");
  expect(f.notifications).toHaveBeenCalled();
  expect(await f.d.select().from(db.failoverEvents).where(eq(db.failoverEvents.poolId, f.pools[0]!.id))).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "pool.no_healthy_endpoint" })]));
});

async function manualPublication(f: Awaited<ReturnType<typeof fixture>>) {
  await f.d.delete(db.addressHealthStates).where(eq(db.addressHealthStates.slotId, f.slot.id));
  await f.d.delete(db.addressHealthPolicies).where(eq(db.addressHealthPolicies.slotId, f.slot.id));
  await f.d.delete(db.healthCheckConfigs).where(eq(db.healthCheckConfigs.id, f.policy.configId));
  await f.d.update(db.instanceAuthorizations).set({ allowIpv4Rotation: true }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  await f.d.insert(db.rotationPolicies).values({ slotId: f.slot.id, enabled: false });
  const segmentId = randomUUID();
  const [incident] = await f.d.insert(db.rotationIncidents).values({
    ownerUserId: f.account.ownerUserId, slotId: f.slot.id, family: "4", trigger: "manual", phase: "publish", currentSegmentId: segmentId,
    physicalKey: JSON.stringify(["aws", f.account.externalAccountId, "ec2", "us-east-1", f.instance.externalId]),
    sourceEventId: `manual-${randomUUID()}`, authorizationRevision: 1, policyRevision: 1, addressVersion: 1,
  }).returning();
  await f.d.insert(db.rotationBudgetSegments).values({ id: segmentId, incidentId: incident!.id, maxAttempts: 1, attemptsUsed: 1, actorUserId: f.account.ownerUserId });
  await f.d.insert(db.rotationPublications).values({ slotId: f.slot.id, incidentId: incident!.id, addressId: f.address.id, addressVersion: 1 });
  return incident!;
}

it("manual publication updates linked DNS without health evidence and retries only failed DNS", async () => {
  const f = await dnsFixture(); const incident = await manualPublication(f);
  await f.service.publish(incident.id);
  const addresses = await f.d.select().from(db.endpointAddresses).where(eq(db.endpointAddresses.endpointId, f.endpoints[0]!.id));
  expect(addresses).toMatchObject([{ healthState: "unknown", consecutiveSuccesses: 0, lastCheckedAt: null }]);
  expect(await f.d.select().from(db.addressHealthStates).where(eq(db.addressHealthStates.slotId, f.slot.id))).toEqual([]);
  await f.plan(); await f.execute();
  const [p] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.incidentId, incident.id));
  await f.service.observe(p!.id);
  expect(f.writes).toEqual(["zone-0"]);
  expect((await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.id, p!.id)))[0]).toMatchObject({ status: "failed", errorCode: "dns_partial" });
  f.state.failSecond = false; await f.execute(); await f.service.observe(p!.id);
  expect(f.writes).toEqual(["zone-0", "zone-1"]);
  expect(f.remote.get("zone-0")?.content).toBe(f.address.address);
  expect(f.remote.get("zone-1")?.content).toBe(f.address.address);
  expect(f.state.cloudCalls).toBe(0);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, incident.id)))[0]).toMatchObject({ phase: "cleanup" });
});
it("termination cancels queued DNS publication and recovery cannot revive it", async () => {
  const f = await dnsFixture(); const incident = await manualPublication(f);
  await f.service.publish(incident.id);
  await f.plan();
  await f.d.transaction(tx => terminateRotationIncident(tx, incident.id, f.account.ownerUserId));
  await f.execute();
  await f.service.recover();
  expect(f.writes).toHaveLength(0);
  for (const pool of f.pools) expect((await f.d.select().from(db.operations).where(eq(db.operations.resourceId, pool.id)))[0]).toMatchObject({ status: "superseded" });
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, incident.id)))[0]).toMatchObject({ status: "complete", errorCode: "manual_terminated" });
});
it("termination prevents an unpromoted candidate becoming an initial publication", async () => {
  const f = await dnsFixture(); const incident = await manualPublication(f);
  await f.d.transaction(tx => terminateRotationIncident(tx, incident.id, f.account.ownerUserId));
  await f.service.publishSlot(f.slot.id);
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]!.currentVersion).toBe(0);
  expect(await f.d.select().from(db.reconcileIntents).where(eq(db.reconcileIntents.poolId, f.pools[0]!.id))).toHaveLength(0);
});

it("manual publication succeeds with no DNS bindings", async () => {
  const f = await fixture(); const incident = await manualPublication(f);
  await f.d.delete(db.cloudEndpointLinks).where(eq(db.cloudEndpointLinks.slotId, f.slot.id));
  await f.service.publish(incident.id);
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]).toMatchObject({ currentAddressId: f.address.id, currentVersion: 1, candidateAddressId: null });
  expect((await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.incidentId, incident.id)))[0]).toMatchObject({ status: "applied", children: [] });
});

it("completed manual publication does not override later binding health failures", async () => {
  const f = await dnsFixture(); const incident = await manualPublication(f);
  f.state.failSecond = false;
  await f.service.publish(incident.id); await f.plan(); await f.execute();
  const [publication] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.incidentId, incident.id));
  await f.service.observe(publication!.id);
  await f.d.update(db.rotationIncidents).set({ phase: "complete", status: "complete", completedAt: new Date() }).where(eq(db.rotationIncidents.id, incident.id));
  const pool = f.pools[0]!, binding = f.bindings[0]!;
  const [backup] = await f.d.insert(db.endpoints).values({ poolId: pool.id, name: "backup", addressMode: "static", healthState: "healthy", priority: 200 }).returning();
  const [backupAddress] = await f.d.insert(db.endpointAddresses).values({ endpointId: backup!.id, family: "4", address: "192.0.2.88", source: "static", state: "current", healthState: "healthy" }).returning();
  const [current] = await f.d.select().from(db.endpointAddresses).where(eq(db.endpointAddresses.endpointId, f.endpoints[0]!.id));
  await f.d.insert(db.healthCheckConfigs).values({ domainBindingId: binding.id, checkerType: "tcp", config: { port: 443 } });
  await f.d.insert(db.bindingEndpointHealth).values([
    { domainBindingId: binding.id, endpointId: f.endpoints[0]!.id, endpointAddressId: current!.id, healthState: "unhealthy", consecutiveFailures: 3 },
    { domainBindingId: binding.id, endpointId: backup!.id, endpointAddressId: backupAddress!.id, healthState: "healthy", consecutiveSuccesses: 3 },
  ]);
  const [latestPool] = await f.d.select().from(db.endpointPools).where(eq(db.endpointPools.id, pool.id));
  const decisionRevision = latestPool!.decisionRevision + 1;
  await f.d.update(db.endpointPools).set({ decisionRevision }).where(eq(db.endpointPools.id, pool.id));
  await f.d.insert(db.reconcileIntents).values({ poolId: pool.id, eventId: randomUUID(), policyRevision: latestPool!.policyRevision, decisionRevision, trigger: "failure", source: "failover" });
  await f.plan(); await f.execute();
  expect(f.remote.get("zone-0")?.content).toBe("192.0.2.88");
});

it("later healthy DNS repairs use current authorization after a completed manual publication", async () => {
  const f = await dnsFixture(); const incident = await manualPublication(f);
  f.state.failSecond = false;
  await f.service.publish(incident.id); await f.plan(); await f.execute();
  const [publication] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.incidentId, incident.id));
  await f.service.observe(publication!.id);
  await f.d.update(db.rotationIncidents).set({ phase: "complete", status: "complete", completedAt: new Date() }).where(eq(db.rotationIncidents.id, incident.id));
  await f.d.update(db.instanceAuthorizations).set({ revision: 2 }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  await f.d.update(db.rotationPolicies).set({ revision: 2, enabled: true }).where(eq(db.rotationPolicies.slotId, f.slot.id));
  await f.d.insert(db.healthCheckConfigs).values({ id: f.policy.configId, slotId: f.slot.id, checkerType: "tcp", config: { port: 443 }, revision: 2 });
  await f.d.insert(db.addressHealthPolicies).values({ id: f.policy.id, slotId: f.slot.id, family: "4", configId: f.policy.configId, groupId: f.policy.groupId, revision: 2 });
  await f.d.insert(db.addressHealthStates).values({ slotId: f.slot.id, family: "4", addressId: f.address.id, addressVersion: 1, configId: f.policy.configId, configVersion: 2, policyId: f.policy.id, policyRevision: 2, groupRevision: 1, healthState: "healthy", latestDecision: "success", consecutiveSuccesses: 3, lastCheckedAt: new Date(), evidenceExpiresAt: new Date(Date.now() + 60000) });
  const pool = f.pools[0]!;
  await f.d.update(db.endpointAddresses).set({ healthState: "healthy", consecutiveSuccesses: 3 }).where(eq(db.endpointAddresses.endpointId, f.endpoints[0]!.id));
  f.remote.set("zone-0", { ...f.remote.get("zone-0")!, content: "192.0.2.99" });
  await f.d.update(db.dnsRecords).set({ content: "192.0.2.99" }).where(eq(db.dnsRecords.managedByPoolId, pool.id));
  const [latestPool] = await f.d.select().from(db.endpointPools).where(eq(db.endpointPools.id, pool.id));
  const decisionRevision = latestPool!.decisionRevision + 1;
  await f.d.update(db.endpointPools).set({ decisionRevision }).where(eq(db.endpointPools.id, pool.id));
  await f.d.insert(db.reconcileIntents).values({ poolId: pool.id, eventId: randomUUID(), policyRevision: latestPool!.policyRevision, decisionRevision, trigger: "repair", source: "failover" });
  await f.plan(); await f.execute();
  expect(f.remote.get("zone-0")?.content).toBe(f.address.address);
});

it.each(["authorization", "version", "live", "manual_authority"] as const)("manual DNS dispatch rechecks %s after planning", async change => {
  const f = await dnsFixture(); const incident = await manualPublication(f);
  await f.service.publish(incident.id); await f.plan();
  if (change === "authorization") await f.d.update(db.instanceAuthorizations).set({ managed: false, revision: 2 }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  if (change === "version") await f.d.update(db.managedAddressSlots).set({ currentVersion: 2 }).where(eq(db.managedAddressSlots.id, f.slot.id));
  if (change === "live") f.live.interfaces[0]!.addresses[0]!.address = "192.0.2.99";
  if (change === "manual_authority") {
    const ops = await f.d.select().from(db.operations).where(eq(db.operations.resourceId, f.pools[0]!.id));
    for (const op of ops) {
      const steps = await f.d.select().from(db.operationSteps).where(eq(db.operationSteps.operationId, op.id));
      for (const step of steps) await f.d.update(db.operationSteps).set({ input: { ...step.input, cloud: { ...(step.input.cloud as Record<string, unknown>), manualIncidentId: randomUUID() } } }).where(eq(db.operationSteps.id, step.id));
    }
    f.state.failSecond = true;
  }
  await f.execute(); expect(f.writes).toEqual([]);
});
it("retries only failed DNS provider operations, records children and never allocates during partial publication", async () => {
  const f = await dnsFixture();
  await f.service.publishSlot(f.slot.id);
  await f.plan();
  await f.execute();
  let [p] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.slotId, f.slot.id));
  await f.service.observe(p!.id);
  [p] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.slotId, f.slot.id));
  expect(p).toMatchObject({ status: "failed", errorCode: "dns_partial" });
  expect(p!.children.every((c) => c.operationId)).toBe(true);
  expect(f.writes).toEqual(["zone-0"]);
  f.state.failSecond = false;
  await f.execute();
  await f.service.observe(p!.id);
  expect(f.writes).toEqual(["zone-0", "zone-1"]);
  expect(f.state.cloudCalls).toBe(0);
  expect((await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.slotId, f.slot.id)))[0]!.status).toBe(
    "applied",
  );
});
it("preserves a healthy selected backup during shared-slot promotion", async () => {
  const f = await dnsFixture(true);
  f.state.failSecond = false;
  await f.service.publishSlot(f.slot.id);
  await f.plan();
  await f.execute();
  expect(f.remote.get("zone-1")!.content).toBe("192.0.2.88");
  expect(f.writes).toEqual(["zone-0"]);
});
it.each(["authorization", "config", "group", "version", "live"] as const)("rechecks %s at DNS dispatch after planning", async (change) => {
  const f = await dnsFixture();
  await f.service.publishSlot(f.slot.id);
  await f.plan();
  if (change === "authorization")
    await f.d
      .update(db.instanceAuthorizations)
      .set({ revision: 2, managed: false })
      .where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  if (change === "config")
    await f.d.update(db.healthCheckConfigs).set({ revision: 2 }).where(eq(db.healthCheckConfigs.id, f.policy.configId));
  if (change === "group") await f.d.update(db.probeGroups).set({ revision: 2 }).where(eq(db.probeGroups.id, f.policy.groupId!));
  if (change === "version")
    await f.d.update(db.managedAddressSlots).set({ currentVersion: 2 }).where(eq(db.managedAddressSlots.id, f.slot.id));
  if (change === "live") f.live.interfaces[0]!.addresses[0]!.address = "192.0.2.99";
  await f.execute();
  expect(f.writes).toHaveLength(0);
});
it("cloud policy restore preserves stable links, discards old evidence and requires a newly verified live version", async () => {
  const f = await fixture();
  await f.service.publishSlot(f.slot.id);
  const links = await f.d.transaction((tx) => db.captureCloudPolicyLinks(tx, f.pools[0]!.id));
  await f.d.transaction((tx) => db.prepareCloudPolicyRestore(tx, f.pools[0]!.id, f.account.ownerUserId, links));
  let [slot] = await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id));
  expect(slot).toMatchObject({ currentVersion: 1, candidateVersion: 2, candidateAddressId: f.address.id });
  const [health] = await f.d.select().from(db.addressHealthStates).where(eq(db.addressHealthStates.slotId, f.slot.id));
  expect(health).toMatchObject({ latestDecision: "unknown", consecutiveSuccesses: 0 });
  await f.service.recover();
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]!.currentVersion).toBe(1);
  expect(await f.d.transaction((tx) => db.captureCloudPolicyLinks(tx, f.pools[0]!.id))).toEqual(links);
  await f.d
    .update(db.addressHealthStates)
    .set({
      addressVersion: 2,
      latestDecision: "success",
      healthState: "healthy",
      consecutiveSuccesses: 3,
      lastCheckedAt: new Date(),
      evidenceExpiresAt: new Date(Date.now() + 60000),
    })
    .where(eq(db.addressHealthStates.slotId, f.slot.id));
  await f.service.publishSlot(f.slot.id);
  [slot] = await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id));
  expect(slot!.currentVersion).toBe(2);
});

import { RotationStore } from "./rotation-store.js";
import { RotationProcessor } from "./rotation.processor.js";
import { RotationCleanupService } from "./rotation-cleanup.service.js";
it.each(["system", "user"] as const)("runs one allocation and cleans the old %s IP only after all providers plus TTL grace", async (origin) => {
  const f = await dnsFixture();
  f.state.failSecond = false;
  await f.service.publishSlot(f.slot.id);
  await f.plan();
  await f.execute();
  const [initial] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.slotId, f.slot.id));
  await f.service.observe(initial!.id);
  await f.d.update(db.domainBindings).set({ ttl: 1 }).where(eq(db.domainBindings.id, f.bindings[0]!.id));
  await f.d.update(db.dnsRecords).set({ ttl: 1 }).where(eq(db.dnsRecords.zoneId, f.bindings[0]!.zoneId));
  await f.d
    .update(db.cloudAddresses)
    .set({ remoteAllocationId: "eipalloc-old", origin, attemptId: origin === "system" ? randomUUID() : null })
    .where(eq(db.cloudAddresses.id, f.address.id));
  Object.assign(f.live.interfaces[0]!.addresses[0]!, { allocationId: "eipalloc-old", privateAddress: "10.0.0.1" });
  await f.d
    .update(db.instanceAuthorizations)
    .set({ allowIpv4Rotation: true })
    .where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  await f.d.insert(db.rotationPolicies).values({ slotId: f.slot.id, enabled: true });
  await f.d
    .update(db.addressHealthStates)
    .set({
      latestDecision: "failure",
      healthState: "unhealthy",
      consecutiveSuccesses: 0,
      consecutiveFailures: 3,
      lastRoundId: randomUUID(),
    })
    .where(eq(db.addressHealthStates.slotId, f.slot.id));
  const incident = await f.d.transaction(async (tx) =>
    db.createRotationIncident(tx, await db.lockRotationContext(tx, f.slot.id), randomUUID()),
  );
  let allocations = 0;
  const receipt = { candidateAddress: "198.51.100.33", allocationId: "eipalloc-new" };
  const adapter = {
    inspect: async () => structuredClone(f.live),
    execute: async (step: any) => {
      if (step.action.endsWith("allocate")) allocations++;
      if (step.action.endsWith("associate"))
        Object.assign(f.live.interfaces[0]!.addresses[0]!, { address: receipt.candidateAddress, allocationId: receipt.allocationId });
      return receipt;
    },
    observeDetails: async () => ({ ...receipt, status: "applied" }),
  };
  const processor = new RotationProcessor(new RotationStore({ db: f.d } as never), { adapter: async () => adapter } as never, {} as never);
  for (let n = 0; n < 5; n++) await processor.run(incident.id);
  const [candidate] = await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id));
  await f.d
    .update(db.addressHealthStates)
    .set({
      addressId: candidate!.candidateAddressId,
      addressVersion: candidate!.candidateVersion,
      latestDecision: "success",
      healthState: "healthy",
      consecutiveSuccesses: 3,
      consecutiveFailures: 0,
      lastCheckedAt: new Date(),
      evidenceExpiresAt: new Date(Date.now() + 60000),
    })
    .where(eq(db.addressHealthStates.slotId, f.slot.id));
  await processor.run(incident.id);
  await f.service.publish(incident.id);
  await f.plan();
  await f.d.update(db.rotationIncidents).set({ pausedByUserId: f.account.ownerUserId }).where(eq(db.rotationIncidents.id, incident.id));
  await f.execute();
  expect(f.writes).toHaveLength(2); // Only the initial binding writes occurred.
  await f.d.update(db.rotationIncidents).set({ pausedByUserId: null }).where(eq(db.rotationIncidents.id, incident.id));
  const [pausedPublication] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.incidentId, incident.id));
  await f.service.observe(pausedPublication!.id);
  f.state.failSecond = true;
  await f.execute();
  let [p] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.incidentId, incident.id));
  await f.service.observe(p!.id);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, incident.id)))[0]!.errorCode).toBe("dns_partial");
  expect(
    (await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.incidentId, incident.id))).every((r) => !r.cleanupDueAt),
  ).toBe(true);
  f.state.failSecond = false;
  await f.execute();
  await f.service.observe(p!.id);
  [p] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.id, p!.id));
  expect(allocations).toBe(1);
  expect(f.writes.filter((z) => z === "zone-0")).toHaveLength(2);
  expect(p!.previousMaxTtl).toBe(300);
  const resources = await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.incidentId, incident.id));
  const old = resources.find((r) => r.role === "original")!;
  expect(old.cleanupStatus).toBe("pending");
  expect(old.cleanupDueAt!.getTime() - p!.appliedAt!.getTime()).toBe(360000);
  const cleanup = new RotationCleanupService({ db: f.d } as never, { adapter: async () => adapter } as never);
  await cleanup.run(old.id, new Date(Date.now() + 9999999));
  await cleanup.complete(incident.id);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, incident.id)))[0]!.status).not.toBe("complete");
  expect(allocations).toBe(1);
});

it("discovers a newly linked endpoint on an already published slot and requires fresh version evidence", async () => {
  const f = await fixture();
  await f.service.publishSlot(f.slot.id);
  const [endpoint] = await f.d.insert(db.endpoints).values({ poolId: f.pools[0]!.id, name: "late-link", addressMode: "cloud" }).returning();
  await f.d.insert(db.cloudEndpointLinks).values({ endpointId: endpoint!.id, family: "4", slotId: f.slot.id });
  await f.service.recover();
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]).toMatchObject({
    currentVersion: 1,
    candidateVersion: 2,
    candidateAddressId: f.address.id,
  });
  expect(await f.d.select().from(db.endpointAddresses).where(eq(db.endpointAddresses.endpointId, endpoint!.id))).toHaveLength(0);
  await f.d
    .update(db.addressHealthStates)
    .set({
      addressVersion: 2,
      healthState: "healthy",
      latestDecision: "success",
      consecutiveSuccesses: 3,
      lastCheckedAt: new Date(),
      evidenceExpiresAt: new Date(Date.now() + 60000),
    })
    .where(eq(db.addressHealthStates.slotId, f.slot.id));
  await f.service.publishSlot(f.slot.id);
  expect(await f.d.select().from(db.endpointAddresses).where(eq(db.endpointAddresses.endpointId, endpoint!.id))).toMatchObject([
    { address: f.address.address, state: "current", source: "cloud" },
  ]);
});

it("blocks DNS dispatch while a physical-instance cloud step remains unresolved", async () => {
  const f = await dnsFixture();
  await f.service.publishSlot(f.slot.id);
  await f.plan();
  const segmentId = randomUUID(),
    attemptId = randomUUID(),
    stepId = `uncertain-${randomUUID()}`;
  const physicalKey = JSON.stringify(["aws", f.account.externalAccountId, "ec2", "us-east-1", f.instance.externalId]);
  const [incident] = await f.d
    .insert(db.rotationIncidents)
    .values({
      ownerUserId: f.account.ownerUserId,
      slotId: f.slot.id,
      family: "4",
      physicalKey,
      sourceEventId: randomUUID(),
      currentSegmentId: segmentId,
      authorizationRevision: 1,
      policyRevision: 1,
      addressVersion: 1,
      healthPolicyId: f.policy.id,
      healthPolicyRevision: 1,
      configId: f.policy.configId,
      configRevision: 1,
      groupId: f.policy.groupId!,
      groupRevision: 1,
    })
    .returning();
  await f.d.insert(db.rotationBudgetSegments).values({ id: segmentId, incidentId: incident!.id, maxAttempts: 3 });
  await f.d
    .insert(db.rotationAttempts)
    .values({ id: attemptId, incidentId: incident!.id, segmentId, sequence: 1, beforeInventory: f.live });
  await f.d.insert(db.rotationSteps).values({
    id: stepId,
    attemptId,
    sequence: 0,
    status: "in_flight",
    plan: { id: stepId, action: "ec2.eip.associate", resourceKey: physicalKey, arguments: { phase: "rotation" }, destructive: true },
  });
  await f.d.update(db.rotationLeases).set({ unresolvedStepId: stepId }).where(eq(db.rotationLeases.physicalKey, physicalKey));
  await f.execute();
  expect(f.writes).toHaveLength(0);
});

import { ProbeHealthService } from "../probes/probe-health.service.js";
import { ProbeSchedulerService } from "../probes/probe-scheduler.service.js";
import { HealthResultService } from "../health/health-result.service.js";
async function cloudHealthFixture() {
  const f = await dnsFixture();
  f.state.failSecond = false;
  await f.service.publishSlot(f.slot.id);
  await f.plan();
  await f.execute();
  const [publication] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.slotId, f.slot.id));
  await f.service.observe(publication!.id);
  const backups = [];
  for (const pool of f.pools) {
    const [backup] = await f.d
      .insert(db.endpoints)
      .values({ poolId: pool.id, name: "healthy-backup", addressMode: "static", priority: 200, healthState: "healthy" })
      .returning();
    backups.push(backup!);
    await f.d
      .insert(db.endpointAddresses)
      .values({ endpointId: backup!.id, family: "4", address: "192.0.2.88", source: "static", state: "current", healthState: "healthy" });
  }
  const [agent] = await f.d
    .insert(db.probeAgents)
    .values({ ownerUserId: f.account.ownerUserId, name: "external", capabilities: { ipv4: true, ipv6: true } })
    .returning();
  await f.d.insert(db.probeGroupMembers).values({ groupId: f.policy.groupId!, probeId: agent!.id });
  const results = new HealthResultService({ db: f.d } as never);
  const health = new ProbeHealthService({ db: f.d } as never, results);
  const scheduler = new ProbeSchedulerService({ db: f.d } as never, health);
  let sequence = 0;
  const start = Date.now();
  const round = async (decision: "success" | "failure" | "unknown") => {
    const r = await scheduler.schedulePolicy(f.policy.id, new Date(start + sequence++ * 15000));
    expect(r).toBeDefined();
    if (decision !== "unknown") {
      const [task] = await f.d.select().from(db.probeTasks).where(eq(db.probeTasks.roundId, r!.id));
      await f.d.insert(db.probeObservations).values({
        taskId: task!.id,
        roundId: r!.id,
        probeId: agent!.id,
        leaseId: randomUUID(),
        addressVersion: r!.addressVersion,
        configVersion: r!.configVersion,
        status: "accepted",
        outcome: decision,
        latencyMs: 1,
        measuredAt: new Date(),
        receivedAt: new Date(r!.deadline.getTime() - 1),
      });
    }
    await health.closeRound(r!.id, r!.deadline);
    return r!;
  };
  return { ...f, backups, round, results, health };
}

it("preserves binding override failures when external slot success arrives and ignores disabled overrides", async () => {
  const f = await cloudHealthFixture();
  const binding = f.bindings[0]!;
  const [config] = await f.d.insert(db.healthCheckConfigs).values({ domainBindingId: binding.id, checkerType: "tcp", config: { type: "tcp", port: 443 } }).returning();
  for (const endpoint of [f.endpoints[0]!, f.backups[0]!]) {
    const [address] = await f.d.select().from(db.endpointAddresses).where(eq(db.endpointAddresses.endpointId, endpoint.id));
    await f.d.insert(db.bindingEndpointHealth).values({ domainBindingId: binding.id, endpointId: endpoint.id, endpointAddressId: address!.id, healthState: "unhealthy" });
  }
  await f.round("success");
  expect((await f.d.select().from(db.endpointPools).where(eq(db.endpointPools.id, f.pools[0]!.id)))[0]!.state).toBe("unhealthy");
  await f.d.update(db.healthCheckConfigs).set({ enabled: false }).where(eq(db.healthCheckConfigs.id, config!.id));
  await f.round("success");
  expect((await f.d.select().from(db.endpointPools).where(eq(db.endpointPools.id, f.pools[0]!.id)))[0]!.state).toBe("healthy");
});
it("atomically fans three current-slot failures into both Pools and normal backup selection, preserving keep-current recovery", async () => {
  const f = await cloudHealthFixture();
  await f.round("failure");
  await f.round("failure");
  expect((await f.d.select().from(db.endpoints).where(eq(db.endpoints.id, f.endpoints[0]!.id)))[0]!.healthState).not.toBe("unhealthy");
  const closed = await f.round("failure");
  for (const endpoint of f.endpoints) {
    expect((await f.d.select().from(db.endpoints).where(eq(db.endpoints.id, endpoint.id)))[0]!.healthState).toBe("unhealthy");
    expect(await f.d.select().from(db.reconcileIntents).where(eq(db.reconcileIntents.poolId, endpoint.poolId))).toEqual(
      expect.arrayContaining([expect.objectContaining({ trigger: "failure", endpointId: endpoint.id })]),
    );
  }
  expect((await f.d.select().from(db.probeRounds).where(eq(db.probeRounds.id, closed.id)))[0]!.status).toBe("completed");
  await f.plan();
  await f.execute();
  expect(f.remote.get("zone-0")!.content).toBe("192.0.2.88");
  expect(f.remote.get("zone-1")!.content).toBe("192.0.2.88");
  await f.round("success");
  await f.round("success");
  await f.round("success");
  await f.plan();
  await f.execute();
  expect(f.remote.get("zone-0")!.content).toBe("192.0.2.88");
  expect(f.remote.get("zone-1")!.content).toBe("192.0.2.88");
});
it("does not fan candidate outcomes into the published endpoint and unknown does not cause failover", async () => {
  const f = await cloudHealthFixture();
  await f.round("unknown");
  const intentsBefore = (await f.d.select().from(db.reconcileIntents).where(eq(db.reconcileIntents.poolId, f.pools[0]!.id))).length;
  const [candidate] = await f.d
    .insert(db.cloudAddresses)
    .values({ interfaceId: f.slot.interfaceId, family: "4", kind: "host", address: "198.51.100.44", origin: "system", scanGeneration: 1 })
    .returning();
  await f.d
    .update(db.managedAddressSlots)
    .set({ candidateAddressId: candidate!.id, candidateVersion: 2 })
    .where(eq(db.managedAddressSlots.id, f.slot.id));
  await f.round("failure");
  await f.round("failure");
  await f.round("failure");
  for (const endpoint of f.endpoints)
    expect((await f.d.select().from(db.endpoints).where(eq(db.endpoints.id, endpoint.id)))[0]!.healthState).toBe("healthy");
  await f.round("success");
  await f.round("success");
  await f.round("success");
  for (const endpoint of f.endpoints)
    expect(
      (await f.d.select().from(db.endpointAddresses).where(eq(db.endpointAddresses.endpointId, endpoint.id)))[0]!.consecutiveSuccesses,
    ).toBe(0);
  expect((await f.d.select().from(db.reconcileIntents).where(eq(db.reconcileIntents.poolId, f.pools[0]!.id))).length).toBe(intentsBefore);
});

it("rolls back the round and every Pool if current-slot health fanout cannot finish atomically", async () => {
  const f = await cloudHealthFixture();
  await f.round("failure");
  await f.round("failure");
  const apply = f.results.applyObserved.bind(f.results);
  let calls = 0;
  const spy = vi.spyOn(f.results, "applyObserved").mockImplementation(async (...args) => {
    if (++calls === 2) throw new Error("injected_pool_write_failure");
    return apply(...args);
  });
  await expect(f.round("failure")).rejects.toThrow("injected_pool_write_failure");
  spy.mockRestore();
  const [state] = await f.d.select().from(db.addressHealthStates).where(eq(db.addressHealthStates.slotId, f.slot.id));
  expect(state!.consecutiveFailures).toBe(2);
  for (const endpoint of f.endpoints)
    expect((await f.d.select().from(db.endpoints).where(eq(db.endpoints.id, endpoint.id)))[0]!.healthState).toBe("degraded");
  const pending = (await f.d.select().from(db.probeRounds).where(eq(db.probeRounds.slotId, f.slot.id))).find(
    (r) => r.status === "pending",
  )!;
  expect(pending).toBeDefined();
  await f.health.closeRound(pending.id, pending.deadline);
  for (const endpoint of f.endpoints)
    expect((await f.d.select().from(db.endpoints).where(eq(db.endpoints.id, endpoint.id)))[0]!.healthState).toBe("unhealthy");
});

it("does not turn an unknown round's historical unhealthy slot state into new Pool failover", async () => {
  const f = await cloudHealthFixture();
  await f.d
    .update(db.addressHealthStates)
    .set({ healthState: "unhealthy", latestDecision: "failure", consecutiveFailures: 3, consecutiveSuccesses: 0 })
    .where(eq(db.addressHealthStates.slotId, f.slot.id));
  await f.round("unknown");
  for (const endpoint of f.endpoints)
    expect((await f.d.select().from(db.endpoints).where(eq(db.endpoints.id, endpoint.id)))[0]!.healthState).toBe("healthy");
});

it.each(["new-link", "restore"] as const)(
  "propagates fresh same-address revalidation failure after %s with auto rotation off",
  async (reason) => {
    const f = await cloudHealthFixture();
    if (reason === "new-link") {
      const [endpoint] = await f.d
        .insert(db.endpoints)
        .values({ poolId: f.pools[0]!.id, name: "new-binding", addressMode: "cloud" })
        .returning();
      await f.d.insert(db.cloudEndpointLinks).values({ endpointId: endpoint!.id, slotId: f.slot.id, family: "4" });
      await f.service.recover();
    } else {
      const links = await f.d.transaction((tx) => db.captureCloudPolicyLinks(tx, f.pools[0]!.id));
      await f.d.transaction((tx) => db.prepareCloudPolicyRestore(tx, f.pools[0]!.id, f.account.ownerUserId, links));
    }
    const [slot] = await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id));
    expect(slot).toMatchObject({
      currentAddressId: f.address.id,
      candidateAddressId: f.address.id,
      currentVersion: 1,
      candidateVersion: 2,
    });
    await f.round("failure");
    await f.round("failure");
    for (const endpoint of f.endpoints)
      expect((await f.d.select().from(db.endpoints).where(eq(db.endpoints.id, endpoint.id)))[0]!.healthState).not.toBe("unhealthy");
    await f.round("failure");
    for (const endpoint of f.endpoints)
      expect((await f.d.select().from(db.endpoints).where(eq(db.endpoints.id, endpoint.id)))[0]!.healthState).toBe("unhealthy");
    await f.plan();
    await f.execute();
    expect(f.remote.get("zone-0")!.content).toBe("192.0.2.88");
    expect(f.remote.get("zone-1")!.content).toBe("192.0.2.88");
    await f.round("success");
    await f.round("success");
    await f.round("success");
    for (const endpoint of f.endpoints)
      expect((await f.d.select().from(db.endpoints).where(eq(db.endpoints.id, endpoint.id)))[0]!.healthState).toBe("unhealthy");
    expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]).toMatchObject({
      currentVersion: 1,
      candidateVersion: 2,
    });
    expect(await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.slotId, f.slot.id))).toHaveLength(0);
  },
);

it("does not publish a recreated provider allocation with a different persisted resource identity", async () => {
  const f = await fixture();
  await f.d.update(db.cloudAddresses).set({ remoteAllocationId: "allocation", metadata: { resourceId: "resource", providerMetadata: { resourceGuid: "original-guid" } } }).where(eq(db.cloudAddresses.id, f.address.id));
  Object.assign(f.live.interfaces[0]!.addresses[0]!, { allocationId: "allocation", resourceId: "resource", metadata: { resourceGuid: "replacement-guid" } });
  await expect(f.service.publishSlot(f.slot.id)).rejects.toThrow("live_cloud_address_changed");
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]!.currentVersion).toBe(0);
});
