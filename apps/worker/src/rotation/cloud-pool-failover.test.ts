import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { Redis } from "ioredis";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as db from "@masterdns/db";
import type { DnsRecordInput, ProviderRecord } from "@masterdns/contracts";
vi.mock("../env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { fixture } from "./rotation-test-utils.js";
import { RotationPublicationService } from "./rotation-publication.service.js";
import { ReconcileProcessor } from "../automation/reconcile.processor.js";
import { OperationProcessor } from "../operations/operation.processor.js";
import { HealthResultService } from "../health/health-result.service.js";
import { ProbeHealthService } from "../probes/probe-health.service.js";
import { ProbeSchedulerService } from "../probes/probe-scheduler.service.js";

let redis: Redis;
beforeAll(async () => {
  redis = new Redis(process.env.MASTERDNS_TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  await redis.ping();
});
afterAll(async () => { await redis?.quit(); });

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

async function poolFixture(recoveryMode: "automatic" | "keep_current" = "automatic", finishLastPublication = true, manualPrimary = false) {
  const primary = await fixture();
  const backup = await fixture();
  const d = primary.d, pool = primary.pools[0]!, endpoint = primary.endpoints[0]!;
  await d.update(db.endpointPools).set({ recoveryMode, switchCooldownSeconds: 0 }).where(eq(db.endpointPools.id, pool.id));
  await d.update(db.cloudAccounts).set({ ownerUserId: primary.account.ownerUserId }).where(eq(db.cloudAccounts.id, backup.account.id));
  await d.update(db.endpoints).set({ poolId: pool.id, name: "backup", priority: 200 }).where(eq(db.endpoints.id, backup.endpoints[0]!.id));
  await d.update(db.cloudAddresses).set({ address: "192.0.2.20" }).where(eq(db.cloudAddresses.id, backup.address.id));
  backup.live.interfaces[0]!.addresses[0]!.address = "192.0.2.20";
  for (const target of [primary, backup]) {
    await d.delete(db.cloudEndpointLinks).where(eq(db.cloudEndpointLinks.slotId, target.slot.id));
    await d.insert(db.cloudEndpointLinks).values({ endpointId: target.endpoints[0]!.id, slotId: target.slot.id, family: "4" });
  }
  // A and AAAA belong to the same endpoint, but are independently verified slots.
  const [ipv6] = await d.insert(db.cloudAddresses).values({ interfaceId: primary.slot.interfaceId, family: "6", kind: "host", address: "2001:db8::10", origin: "user", scanGeneration: 1 }).returning();
  const [v6slot] = await d.insert(db.managedAddressSlots).values({ interfaceId: primary.slot.interfaceId, family: "6", name: "v6", currentAddressId: ipv6!.id, candidateAddressId: ipv6!.id, candidateVersion: 1 }).returning();
  const [v6config] = await d.insert(db.healthCheckConfigs).values({ slotId: v6slot!.id, checkerType: "tcp", config: { type: "tcp", port: 443, timeoutMs: 3000 } }).returning();
  const [v6policy] = await d.insert(db.addressHealthPolicies).values({ slotId: v6slot!.id, family: "6", configId: v6config!.id, groupId: primary.policy.groupId }).returning();
  await d.insert(db.cloudEndpointLinks).values({ endpointId: endpoint.id, slotId: v6slot!.id, family: "6" });
  primary.live.interfaces[0]!.addresses.push({ address: ipv6!.address, family: 6, primary: false });
  const policies = [primary.policy, backup.policy, v6policy!];
  const agents = await d.insert(db.probeAgents).values([1, 2].map(n => ({ ownerUserId: primary.account.ownerUserId, name: `probe-${n}`, capabilities: { ipv4: true, ipv6: true } }))).returning();
  for (const groupId of new Set(policies.map(p => p.groupId!))) {
    await d.update(db.probeGroups).set({ ownerUserId: primary.account.ownerUserId }).where(eq(db.probeGroups.id, groupId));
    await d.insert(db.probeGroupMembers).values(agents.map(agent => ({ groupId, probeId: agent.id })));
  }
  for (const policy of policies) {
    await d.update(db.addressHealthPolicies).set({ mode: "external", consensus: { mode: "all", minimumValid: 2 }, successThreshold: 2, failureThreshold: 2 }).where(eq(db.addressHealthPolicies.id, policy.id));
    await d.delete(db.addressHealthStates).where(eq(db.addressHealthStates.slotId, policy.slotId!));
  }

  const remote = new Map<string, ProviderRecord>();
  const writes: Array<{ zone: string; record: DnsRecordInput }> = [];
  const dnsAccounts: Array<typeof db.providerAccounts.$inferSelect> = [];
  const bindings = [];
  for (const n of [0, 1]) {
    const [account] = await d.insert(db.providerAccounts).values({ ownerUserId: primary.account.ownerUserId, provider: n === 0 ? "cloudflare" : "aliyun", name: `dns-${n}`, status: "active", credentialCiphertext: "test", credentialIv: "iv", credentialTag: "tag" }).returning();
    dnsAccounts.push(account!);
    const [zone] = await d.insert(db.zones).values({ providerAccountId: account!.id, externalId: `zone-${n}`, nameAscii: `zone-${n}.test` }).returning();
    for (const recordType of ["A", "AAAA"] as const) {
      const [binding] = await d.insert(db.domainBindings).values({ poolId: pool.id, zoneId: zone!.id, fqdn: `www.zone-${n}.test`, recordType, originalEndpointId: endpoint.id, ttl: 60 }).returning();
      bindings.push(binding!);
    }
  }
  const cloudRuntime = { adapter: async (accountId: string) => ({ inspect: async () => accountId === primary.account.id ? primary.live : backup.live }) };
  const service = new RotationPublicationService({ db: d } as never, cloudRuntime as never);
  const queues = { redis, operations: { add: async () => ({}) }, notifications: { add: async () => ({}) } };
  const reconcile = new ReconcileProcessor({ db: d } as never, queues as never);
  const operations = new OperationProcessor({ db: d } as never, queues as never, {
    forAccount: async (id: string) => ({ adapter: {
      provider: dnsAccounts.find(account => account.id === id)!.provider,
      listRecords: async (zone: string) => ({ items: [...remote.values()].filter(record => record.zoneExternalId === zone) }),
      getRecord: async (_zone: string, id: string) => remote.get(id) ?? null,
      createRecord: async (zone: string, input: DnsRecordInput) => {
        const record = { ...input, externalId: `${zone}:${input.type}`, zoneExternalId: zone };
        writes.push({ zone, record: input }); remote.set(record.externalId, record); return record;
      },
      updateRecord: async (zone: string, id: string, input: DnsRecordInput) => {
        const record = { ...input, externalId: id, zoneExternalId: zone };
        writes.push({ zone, record: input }); remote.set(id, record); return record;
      },
    } }),
  } as never, cloudRuntime as never);
  const health = new ProbeHealthService({ db: d } as never, new HealthResultService({ db: d } as never));
  const scheduler = new ProbeSchedulerService({ db: d } as never, health);
  let timestamp = Date.now();
  const round = async (policyId: string, outcome: "success" | "failure", rounds = 1) => {
    for (let n = 0; n < rounds; n++) {
      timestamp += 15000;
      const current = await scheduler.schedulePolicy(policyId, new Date(timestamp));
      expect(current).toBeDefined();
      const tasks = await d.select().from(db.probeTasks).where(eq(db.probeTasks.roundId, current!.id));
      expect(tasks).toHaveLength(2);
      await d.insert(db.probeObservations).values(tasks.map(task => ({ taskId: task.id, roundId: current!.id, probeId: task.probeId, leaseId: randomUUID(), addressVersion: current!.addressVersion, configVersion: current!.configVersion, status: "accepted" as const, outcome, latencyMs: 2, measuredAt: new Date(timestamp), receivedAt: new Date(current!.deadline.getTime() - 1) })));
      expect(await health.closeRound(current!.id, current!.deadline)).toBe(outcome);
    }
  };
  const observePublications = async () => {
    const publications = await d.select().from(db.rotationPublications);
    for (const publication of publications.filter(p => [primary.slot.id, backup.slot.id, v6slot!.id].includes(p.slotId))) await service.observe(publication.id);
  };
  const reconcileDns = async (execute = true) => {
    const intents = await d.select().from(db.reconcileIntents).where(and(eq(db.reconcileIntents.poolId, pool.id), isNull(db.reconcileIntents.completedAt))).orderBy(asc(db.reconcileIntents.decisionRevision));
    for (const intent of intents) await (reconcile as unknown as { process(job: unknown): Promise<unknown> }).process({ data: intent });
    const pending = await d.select().from(db.operations).where(and(eq(db.operations.resourceId, pool.id), eq(db.operations.status, "pending")));
    if (execute) for (const operation of pending) await (operations as unknown as { process(job: unknown): Promise<void> }).process({ data: { operationId: operation.id }, attemptsMade: 0, opts: { attempts: 1 } });
    await observePublications();
  };
  const manualIncident = manualPrimary ? await manualPublication(primary) : undefined;
  if (manualIncident) await service.publish(manualIncident.id);
  for (const policy of manualPrimary ? [v6policy!] : policies) {
    await round(policy.id, "success", 2);
    await service.publishSlot(policy.slotId!);
    if (finishLastPublication || policy.id !== v6policy!.id) await reconcileDns();
  }
  return { ...primary, pool, backup, policies, v6slot: v6slot!, bindings, service, round, reconcile, reconcileDns, observePublications, remote, writes, manualIncident };
}

it.each(["automatic", "keep_current"] as const)("fails over two providers' domains using external cloud health and respects %s recovery", async recoveryMode => {
  const f = await poolFixture(recoveryMode);
  for (const zone of ["zone-0", "zone-1"]) {
    expect(f.remote.get(`${zone}:A`)?.content).toBe("192.0.2.10");
    expect(f.remote.get(`${zone}:AAAA`)?.content).toBe("2001:db8::10");
  }
  const ipv6Writes = f.writes.filter(write => write.record.type === "AAAA").length;
  await f.round(f.policy.id, "failure");
  await f.reconcileDns();
  expect(f.remote.get("zone-0:A")?.content).toBe("192.0.2.10");
  await f.round(f.policy.id, "failure");
  await f.reconcileDns();
  for (const zone of ["zone-0", "zone-1"]) expect(f.remote.get(`${zone}:A`)?.content).toBe("192.0.2.20");
  await f.round(f.policy.id, "success", 2);
  await f.reconcileDns();
  for (const zone of ["zone-0", "zone-1"]) {
    expect(f.remote.get(`${zone}:A`)?.content).toBe(recoveryMode === "automatic" ? "192.0.2.10" : "192.0.2.20");
    expect(f.remote.get(`${zone}:AAAA`)?.content).toBe("2001:db8::10");
  }
  expect(f.writes.filter(write => write.record.type === "AAAA")).toHaveLength(ipv6Writes);
});

it("settles all publications when multiple cloud slots share one Pool", async () => {
  const f = await poolFixture("automatic", false);
  // Both A slots initially await the same Pool's AAAA publication. Recovery must
  // converge instead of each observer invalidating the other publication's intent.
  const slots = new Set([f.slot.id, f.backup.slot.id, f.v6slot.id]);
  const publicationStates = async () => (await f.d.select().from(db.rotationPublications)).filter(publication => slots.has(publication.slotId)).map(publication => publication.status);
  const intentCount = (await f.d.select().from(db.reconcileIntents).where(eq(db.reconcileIntents.poolId, f.pool.id))).length;
  for (let n = 0; n < 4; n++) await f.observePublications();
  expect(await f.d.select().from(db.reconcileIntents).where(eq(db.reconcileIntents.poolId, f.pool.id))).toHaveLength(intentCount);
  expect(await publicationStates()).not.toContain("applied");
  await f.reconcileDns(false);
  expect(await publicationStates()).not.toContain("applied");
  expect(await f.d.select().from(db.operations).where(and(eq(db.operations.resourceId, f.pool.id), eq(db.operations.status, "pending")))).toHaveLength(1);
  for (let n = 0; n < 4; n++) await f.reconcileDns();
  expect(await publicationStates()).toEqual(["applied", "applied", "applied"]);
});

it("keeps an unverified rotation candidate out of every domain until its own external threshold passes", async () => {
  const f = await poolFixture();
  for (let n = 0; n < 4; n++) await f.reconcileDns();
  const [candidate] = await f.d.insert(db.cloudAddresses).values({ interfaceId: f.slot.interfaceId, family: "4", kind: "host", address: "192.0.2.99", origin: "system", scanGeneration: 1 }).returning();
  await f.d.update(db.managedAddressSlots).set({ candidateAddressId: candidate!.id, candidateVersion: 2 }).where(eq(db.managedAddressSlots.id, f.slot.id));
  f.live.interfaces[0]!.addresses[0]!.address = candidate!.address;
  await f.round(f.policy.id, "success");
  await expect(f.service.publishSlot(f.slot.id)).rejects.toThrow("fresh_external_success_required");
  await f.reconcileDns();
  for (const zone of ["zone-0", "zone-1"]) expect(f.remote.get(`${zone}:A`)?.content).toBe("192.0.2.10");
  expect(f.writes.some(write => write.record.content === candidate!.address)).toBe(false);
  await f.round(f.policy.id, "success");
  await f.service.publishSlot(f.slot.id);
  await f.reconcileDns();
  for (const zone of ["zone-0", "zone-1"]) {
    expect(f.remote.get(`${zone}:A`)?.content).toBe(candidate!.address);
    expect(f.remote.get(`${zone}:AAAA`)?.content).toBe("2001:db8::10");
  }
});

it("replans a superseded manual IPv4 publication after a healthy IPv6 decision already completed", async () => {
  const f = await poolFixture("automatic", false, true);
  expect(f.manualIncident).toBeDefined();
  expect(await f.d.select().from(db.addressHealthStates).where(eq(db.addressHealthStates.slotId, f.slot.id))).toEqual([]);
  // The manual A decision has not run when verified AAAA supersedes its revision.
  await f.reconcileDns();
  expect(f.remote.get("zone-0:AAAA")?.content).toBe("2001:db8::10");
  const countIntents = async () => (await f.d.select().from(db.reconcileIntents).where(eq(db.reconcileIntents.poolId, f.pool.id))).length;
  const countBeforeRecovery = await countIntents();
  for (let n = 0; n < 6; n++) await f.reconcileDns();
  for (const zone of ["zone-0", "zone-1"]) {
    expect(f.remote.get(`${zone}:A`)?.content).toBe("192.0.2.10");
    expect(f.remote.get(`${zone}:AAAA`)?.content).toBe("2001:db8::10");
  }
  const publications = await f.d.select().from(db.rotationPublications);
  expect(publications.filter(publication => [f.slot.id, f.v6slot.id].includes(publication.slotId)).map(publication => publication.status)).toEqual(["applied", "applied"]);
  const countAfterRecovery = await countIntents();
  expect(countAfterRecovery).toBeLessThanOrEqual(countBeforeRecovery + 1);
  for (let n = 0; n < 3; n++) await f.reconcileDns();
  expect(await countIntents()).toBe(countAfterRecovery);
});

it.each(["legacy_job", "unpromoted", "unrelated_pool"] as const)("rejects manual publication eligibility for %s", async invalidation => {
  const f = await poolFixture("automatic", false, true);
  const [publication] = await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.incidentId, f.manualIncident!.id));
  const [pool] = await f.d.select().from(db.endpointPools).where(eq(db.endpointPools.id, f.pool.id));
  const [intent] = await f.d.select().from(db.reconcileIntents).where(and(eq(db.reconcileIntents.poolId, f.pool.id), eq(db.reconcileIntents.decisionRevision, pool!.decisionRevision)));
  if (invalidation === "unpromoted") await f.d.update(db.rotationPublications).set({ promotedAt: null }).where(eq(db.rotationPublications.id, publication!.id));
  if (invalidation === "unrelated_pool") await f.d.update(db.rotationPublications).set({ children: publication!.children.map(child => ({ ...child, poolId: f.backup.pools[1]!.id })) }).where(eq(db.rotationPublications.id, publication!.id));
  const job = invalidation === "legacy_job"
    ? { poolId: pool!.id, eventId: randomUUID(), policyRevision: pool!.policyRevision, trigger: "repair" }
    : intent!;
  await (f.reconcile as unknown as { process(job: unknown): Promise<unknown> }).process({ data: job });
  const steps = await f.d.select({ input: db.operationSteps.input }).from(db.operationSteps).innerJoin(db.operations, eq(db.operations.id, db.operationSteps.operationId)).where(eq(db.operations.resourceId, f.pool.id));
  // The healthy AAAA still plans normally, proving that the job was evaluated.
  expect(steps).toHaveLength(2);
  expect(steps.map(step => (step.input.record as DnsRecordInput).type)).toEqual(["AAAA", "AAAA"]);
  const bindings = await f.d.select().from(db.domainBindings).where(eq(db.domainBindings.poolId, f.pool.id));
  expect(bindings.filter(binding => binding.recordType === "A").map(binding => binding.state)).toEqual(["failed", "failed"]);
});
