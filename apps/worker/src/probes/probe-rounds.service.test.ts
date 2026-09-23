import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createProbeRound, hasFreshHealthEvidence, probeObservationStats, cloudAccounts, cloudInstances, cloudInterfaces, cloudAddresses, managedAddressSlots, healthCheckConfigs, addressHealthPolicies, addressHealthStates, probeObservations, probeTasks, probeRounds, probeAgents, endpointAddresses, endpoints, reconcileIntents, rotationIncidents, rotationBudgetSegments, rotationAttempts } from "@masterdns/db";
import { randomUUID } from "node:crypto";
import { fixture, testDatabase } from "./probe-test-utils.js";
import { ProbeSchedulerService } from "./probe-scheduler.service.js";
import { ProbeHealthService } from "./probe-health.service.js";
import { HealthResultService } from "../health/health-result.service.js";
let connection: Awaited<ReturnType<typeof testDatabase>>;
let scheduler: ProbeSchedulerService;
let health: ProbeHealthService;
const now = new Date("2026-09-15T01:00:00Z");
beforeAll(async () => { connection = await testDatabase(); const database = { db: connection.db } as never; health = new ProbeHealthService(database, new HealthResultService(database)); scheduler = new ProbeSchedulerService(database, health); }, 30000);
afterAll(async () => { await connection?.dispose(); });
async function target(mode: "external" | "mixed" = "external") {
  const f = await fixture(connection.db);
  const [policy] = await connection.db.insert(addressHealthPolicies).values({ endpointId: f.endpoint.id, family: "4", configId: f.config.id, mode, groupId: f.group.id, consensus: { mode: "majority", minimumValid: mode === "mixed" ? 3 : 2 }, successThreshold: 2, failureThreshold: 2 }).returning();
  return { ...f, policy: policy! };
}
async function vote(roundId: string, outcome: "success" | "failure") {
  const tasks = await connection.db.select().from(probeTasks).where(eq(probeTasks.roundId, roundId));
  const [round] = await connection.db.select().from(probeRounds).where(eq(probeRounds.id, roundId));
  await connection.db.insert(probeObservations).values(tasks.map(task => ({ taskId: task.id, roundId, probeId: task.probeId, leaseId: randomUUID(), addressVersion: round!.addressVersion, configVersion: round!.configVersion, status: "accepted" as const, outcome, latencyMs: 2, measuredAt: now, receivedAt: new Date(round!.deadline.getTime()-1) })));
}
it("deduplicates concurrent schedulers and applies each fixed cohort only once", async () => {
  const f = await target();
  const rounds = await Promise.all([scheduler.schedulePolicy(f.policy.id, now), scheduler.schedulePolicy(f.policy.id, now)]);
  const all = await connection.db.select().from(probeRounds).where(eq(probeRounds.endpointId, f.endpoint.id));
  expect(all).toHaveLength(1); expect(all[0]!.memberIds).toHaveLength(2);
  await vote(all[0]!.id, "failure");
  await Promise.all([health.closeRound(all[0]!.id, all[0]!.deadline), health.closeRound(all[0]!.id, all[0]!.deadline)]);
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.endpointId, f.endpoint.id)))[0]).toMatchObject({ consecutiveFailures: 1, lastAppliedSequence: 1 });
  const second = await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime()+15000));
  await vote(second!.id, "failure"); await health.closeRound(second!.id, second!.deadline);
  await health.closeRound(all[0]!.id, second!.deadline);
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.endpointId, f.endpoint.id)))[0]).toMatchObject({ healthState: "unhealthy", consecutiveFailures: 2, lastAppliedSequence: 2 });
});
it("unknown resets counters and evidence while preserving historical health", async () => {
  const f = await target();
  for (let i=0; i<2; i++) { const r = await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime()+i*15000)); await vote(r!.id, "success"); await health.closeRound(r!.id, r!.deadline); }
  const r = await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime()+30000)); await health.closeRound(r!.id, r!.deadline);
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.endpointId, f.endpoint.id)))[0]).toMatchObject({ healthState: "healthy", consecutiveSuccesses: 0, latestDecision: "unknown", evidenceExpiresAt: null });
});
it("does not shrink the fixed denominator after capability loss", async () => {
  const f = await target();
  await connection.db.update(probeAgents).set({ capabilities: { ipv4: false, ipv6: true } }).where(eq(probeAgents.id, f.agents[0]!.id));
  const r = await scheduler.schedulePolicy(f.policy.id, now);
  expect(r!.memberIds).toHaveLength(2);
  expect(await connection.db.select().from(probeTasks).where(eq(probeTasks.roundId, r!.id))).toHaveLength(1);
  await vote(r!.id, "failure"); await health.closeRound(r!.id, r!.deadline);
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.endpointId, f.endpoint.id)))[0]).toMatchObject({ latestDecision: "unknown", consecutiveFailures: 0 });
});
it("external policies reject local single results", async () => {
  const f = await target();
  const service = new HealthResultService({ db: connection.db } as never);
  await service.apply({ addressId: f.address.id, addressVersion: 1, configId: f.config.id, configVersion: 1, decision: "failure", checkedAt: now });
  expect((await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.id, f.address.id)))[0]).toMatchObject({ healthState: "unknown", consecutiveFailures: 0 });
});
it("accepts local as one immutable vote and cannot rewrite it or invent membership", async () => {
  const f = await target("mixed"); const r = await scheduler.schedulePolicy(f.policy.id, now);
  expect(r!.memberIds.filter(id => id === "local")).toHaveLength(1);
  await vote(r!.id, "success");
  expect(await health.recordLocal(r!.id, "failure", new Date(now.getTime()+1000))).toBe(true);
  expect(await health.recordLocal(r!.id, "success", new Date(now.getTime()+2000))).toBe(false);
  await health.closeRound(r!.id, r!.deadline);
  expect((await connection.db.select().from(probeRounds).where(eq(probeRounds.id, r!.id)))[0]).toMatchObject({ localOutcome: "failure", consensusResult: "success" });
  const external = await target(); const e = await scheduler.schedulePolicy(external.policy.id, now);
  expect(await health.recordLocal(e!.id, "success", now)).toBe(false);
});
it("rejects replaced addresses and expired evidence, never combining successes across a long gap", async () => {
  const f = await target(); const first = await scheduler.schedulePolicy(f.policy.id, now);
  await vote(first!.id, "success"); await health.closeRound(first!.id, first!.deadline);
  const late = await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime()+120000));
  await vote(late!.id, "success"); await health.closeRound(late!.id, late!.deadline);
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.endpointId, f.endpoint.id)))[0]).toMatchObject({ consecutiveSuccesses: 1 });
  const stale = await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime()+135000)); await vote(stale!.id, "success");
  await connection.db.update(endpointAddresses).set({ state: "previous" }).where(eq(endpointAddresses.id, f.address.id));
  await connection.db.insert(endpointAddresses).values({ endpointId: f.endpoint.id, family: "4", address: "192.0.2.2", state: "current", source: "static" });
  await health.closeRound(stale!.id, stale!.deadline);
  expect((await connection.db.select().from(probeRounds).where(eq(probeRounds.id, stale!.id)))[0]!.status).toBe("superseded");
});
it("finalizes higher sequences first without applying an older round later", async () => {
  const f = await target();
  const first = await scheduler.schedulePolicy(f.policy.id, now);
  const second = await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime()+15000));
  await vote(first!.id, "failure"); await vote(second!.id, "failure");
  await health.closeRound(second!.id, second!.deadline); await health.closeRound(first!.id, second!.deadline);
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.endpointId, f.endpoint.id)))[0]).toMatchObject({ lastAppliedSequence: 2, consecutiveFailures: 1 });
});

async function slotTarget(mode: "local" | "external") {
  const f = await fixture(connection.db);
  const [account] = await connection.db.insert(cloudAccounts).values({ ownerUserId: f.actor.id, provider: "aws", name: "account", credentialCiphertext: "test", credentialIv: "test", credentialTag: "test" }).returning();
  const [instance] = await connection.db.insert(cloudInstances).values({ accountId: account!.id, service: "ec2", region: "test", externalId: "i-test", scanGeneration: 1 }).returning();
  const [nic] = await connection.db.insert(cloudInterfaces).values({ instanceId: instance!.id, externalId: "eni-test", scanGeneration: 1 }).returning();
  const [address] = await connection.db.insert(cloudAddresses).values({ interfaceId: nic!.id, kind: "host", family: "4", address: "192.0.2.20", origin: "user", scanGeneration: 1 }).returning();
  const [slot] = await connection.db.insert(managedAddressSlots).values({ interfaceId: nic!.id, family: "4", name: "primary", currentAddressId: address!.id }).returning();
  const [config] = await connection.db.insert(healthCheckConfigs).values({ slotId: slot!.id, checkerType: "tcp", config: { type: "tcp", port: 443, timeoutMs: 3000 } }).returning();
  const [policy] = await connection.db.insert(addressHealthPolicies).values({ slotId: slot!.id, family: "4", configId: config!.id, mode, groupId: mode === "external" ? f.group.id : null, consensus: { mode: "all", minimumValid: mode === "local" ? 1 : 2 }, successThreshold: 1 }).returning();
  return { ...f, slot: slot!, slotAddress: address!, slotConfig: config!, policy: policy! };
}
it("initializes version zero exactly once and keeps verified slot health independent from endpoints", async () => {
  const f = await slotTarget("external");
  await Promise.all([scheduler.schedulePolicy(f.policy.id, now), scheduler.schedulePolicy(f.policy.id, now)]);
  const rounds = await connection.db.select().from(probeRounds).where(eq(probeRounds.slotId, f.slot.id));
  expect(rounds).toHaveLength(1); expect(rounds[0]).toMatchObject({ addressVersion: 1, endpointId: null });
  await vote(rounds[0]!.id, "success"); await health.closeRound(rounds[0]!.id, rounds[0]!.deadline);
  expect((await connection.db.select().from(managedAddressSlots).where(eq(managedAddressSlots.id, f.slot.id)))[0]).toMatchObject({ currentVersion: 0, candidateVersion: 1, candidateAddressId: f.slotAddress.id });
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.slotId, f.slot.id)))[0]).toMatchObject({ addressVersion: 1, healthState: "healthy", latestDecision: "success" });
  expect(await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.endpointId, f.endpoint.id))).toHaveLength(1);
});
it("stops probing historical cloud addresses and invalidates their healthy evidence", async () => {
  const f = await slotTarget("external");
  const first = await scheduler.schedulePolicy(f.policy.id, now);
  await vote(first!.id, "success"); await health.closeRound(first!.id, first!.deadline);
  const [iface] = await connection.db.select().from(cloudInterfaces).where(eq(cloudInterfaces.id, f.slot.interfaceId));
  await connection.db.update(cloudInterfaces).set({ scanGeneration: 2 }).where(eq(cloudInterfaces.id, iface!.id));
  await connection.db.update(cloudInstances).set({ scanGeneration: 2 }).where(eq(cloudInstances.id, iface!.instanceId));
  expect(await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime() + 30000))).toBeUndefined();
  expect(await connection.db.select().from(probeRounds).where(eq(probeRounds.slotId, f.slot.id))).toHaveLength(1);
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.slotId, f.slot.id)))[0]).toMatchObject({ healthState: "unknown", latestDecision: "unknown", evidenceExpiresAt: null });
  await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime() + 31000));
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.slotId, f.slot.id)))[0]!.stateChangedAt).toEqual(new Date(now.getTime() + 30000));
  await expect(connection.db.transaction(tx => createProbeRound(tx, f.actor, { slotId: f.slot.id, addressVersion: 1, configId: f.slotConfig.id, groupId: f.group.id, consensus: { mode: "all", minimumValid: 2 }, deadline: new Date(now.getTime() + 10000), resultExpiresAt: new Date(now.getTime() + 60000) }, now))).rejects.toThrow("Slot address is no longer current");
});
it("continues probing the active rotation candidate while inventory has not observed it", async () => {
  const f = await slotTarget("external");
  const [iface] = await connection.db.select().from(cloudInterfaces).where(eq(cloudInterfaces.id, f.slot.interfaceId));
  await connection.db.update(cloudInterfaces).set({ scanGeneration: 2 }).where(eq(cloudInterfaces.id, iface!.id));
  await connection.db.update(cloudInstances).set({ scanGeneration: 2 }).where(eq(cloudInstances.id, iface!.instanceId));
  const [candidate] = await connection.db.insert(cloudAddresses).values({ interfaceId: iface!.id, kind: "host", family: "4", address: "192.0.2.55", origin: "system", scanGeneration: 1 }).returning();
  await connection.db.update(managedAddressSlots).set({ currentVersion: 1, candidateAddressId: candidate!.id, candidateVersion: 2 }).where(eq(managedAddressSlots.id, f.slot.id));
  const segmentId = randomUUID(); const attemptId = randomUUID();
  const [incident] = await connection.db.insert(rotationIncidents).values({ ownerUserId: f.actor.id, slotId: f.slot.id, family: "4", physicalKey: randomUUID(), sourceEventId: randomUUID(), trigger: "manual", phase: "candidate", currentSegmentId: segmentId, currentAttemptId: attemptId, authorizationRevision: 1, policyRevision: 1, addressVersion: 1 }).returning();
  await connection.db.insert(rotationBudgetSegments).values({ id: segmentId, incidentId: incident!.id, maxAttempts: 3 });
  await connection.db.insert(rotationAttempts).values({ id: attemptId, incidentId: incident!.id, segmentId, sequence: 1, status: "candidate", beforeInventory: {}, candidateAddressId: candidate!.id, candidateVersion: 2 });
  expect(await scheduler.schedulePolicy(f.policy.id, now)).toMatchObject({ address: "192.0.2.55", addressVersion: 2 });
  await connection.db.update(rotationIncidents).set({ status: "complete" }).where(eq(rotationIncidents.id, incident!.id));
  expect(await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime() + 30000))).toBeUndefined();
});
it("local-only slot monitoring produces one local vote without external tasks", async () => {
  const f = await slotTarget("local"); const r = await scheduler.schedulePolicy(f.policy.id, now);
  expect(r).toBeDefined(); expect(r!.memberIds).toEqual(["local"]);
  expect(await connection.db.select().from(probeTasks).where(eq(probeTasks.roundId, r!.id))).toHaveLength(0);
  await health.recordLocal(r!.id, "success", new Date(now.getTime()+1000)); await health.closeRound(r!.id, r!.deadline);
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.slotId, f.slot.id)))[0]).toMatchObject({ latestDecision: "success", healthState: "healthy" });
});
it("resets new versions and refuses expired rounds while retaining sequence fences across config deletion", async () => {
  const f = await target(); const first = await scheduler.schedulePolicy(f.policy.id, now);
  await vote(first!.id, "success"); await health.closeRound(first!.id, first!.deadline);
  const expired = await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime()+15000)); await vote(expired!.id, "success");
  await health.closeRound(expired!.id, expired!.resultExpiresAt);
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.endpointId, f.endpoint.id)))[0]).toMatchObject({ consecutiveSuccesses: 0, latestDecision: "unknown", lastAppliedSequence: 2 });
  await connection.db.delete(healthCheckConfigs).where(eq(healthCheckConfigs.id, f.config.id));
  const [config] = await connection.db.insert(healthCheckConfigs).values({ endpointId: f.endpoint.id, checkerType: "tcp", config: f.config.config }).returning();
  const [policy] = await connection.db.insert(addressHealthPolicies).values({ endpointId: f.endpoint.id, family: "4", configId: config!.id, mode: "external", groupId: f.group.id, consensus: f.policy.consensus }).returning();
  const next = await scheduler.schedulePolicy(policy!.id, new Date(now.getTime()+90000));
  expect(next!.sequence).toBe(3);
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.endpointId, f.endpoint.id)))[0]).toMatchObject({ lastAppliedSequence: 2, consecutiveSuccesses: 0, latestDecision: "unknown", configId: config!.id });
});
it("a newer cloud candidate rejects late prior-version votes", async () => {
  const f = await slotTarget("external"); const first = await scheduler.schedulePolicy(f.policy.id, now); await vote(first!.id, "success");
  const [replacement] = await connection.db.insert(cloudAddresses).values({ interfaceId: f.slot.interfaceId, kind: "host", family: "4", address: "192.0.2.21", origin: "system", scanGeneration: 1 }).returning();
  await connection.db.update(managedAddressSlots).set({ candidateAddressId: replacement!.id, candidateVersion: 2 }).where(eq(managedAddressSlots.id, f.slot.id));
  await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime()+15000));
  await health.closeRound(first!.id, new Date(now.getTime()+20000));
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.slotId, f.slot.id)))[0]).toMatchObject({ addressId: replacement!.id, addressVersion: 2, healthState: "unknown", latestDecision: "unknown", consecutiveSuccesses: 0 });
});
it("aggregates per-probe and family without counting unavailable results as failures", async () => {
  const f = await target();
  const past = new Date(Date.now()-2*86400000);
  const r = await scheduler.schedulePolicy(f.policy.id, past);
  const tasks = await connection.db.select().from(probeTasks).where(eq(probeTasks.roundId, r!.id));
  await connection.db.insert(probeObservations).values(tasks.map((task, i) => ({ taskId: task.id, roundId: r!.id, probeId: task.probeId, leaseId: randomUUID(), addressVersion: 1, configVersion: 1, status: "accepted" as const, outcome: i === 0 ? "success" as const : "unavailable" as const, latencyMs: 2, measuredAt: past, receivedAt: past })));
  const { HealthRetentionService } = await import("../health/health-retention.service.js");
  await new HealthRetentionService({ db: connection.db } as never).aggregateProbes("day");
  const stats = await connection.db.select().from(probeObservationStats).where(eq(probeObservationStats.targetKey, `endpoint:${f.endpoint.id}`));
  expect(stats.map(s => [s.sampleCount, s.successCount, s.unavailableCount]).sort()).toEqual([[0, 0, 1], [1, 1, 0]]);
  await new HealthRetentionService({ db: connection.db } as never).aggregateProbes("day");
  expect(await connection.db.select().from(probeObservationStats).where(eq(probeObservationStats.targetKey, `endpoint:${f.endpoint.id}`))).toHaveLength(2);
});
it("mixed cloud evidence cannot be authorized by the local vote alone", async () => {
  const f = await slotTarget("external");
  await connection.db.update(addressHealthPolicies).set({ mode: "mixed", consensus: { mode: "all", minimumValid: 1 } }).where(eq(addressHealthPolicies.id, f.policy.id));
  const r = await scheduler.schedulePolicy(f.policy.id, now);
  await health.recordLocal(r!.id, "success", new Date(now.getTime()+1000));
  await health.closeRound(r!.id, r!.deadline);
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.slotId, f.slot.id)))[0]).toMatchObject({ latestDecision: "unknown", healthState: "unknown" });
});
it("local execution restrictions contribute unavailable rather than target failure", async () => {
  const f = await slotTarget("local");
  const r = await scheduler.schedulePolicy(f.policy.id, new Date());
  await health.checkLocal(r!.id);
  expect((await connection.db.select().from(probeRounds).where(eq(probeRounds.id, r!.id)))[0]).toMatchObject({ localOutcome: "unavailable" });
});
it("supersedes a queued local cloud round when its address leaves inventory", async () => {
  const f = await slotTarget("local");
  const r = await scheduler.schedulePolicy(f.policy.id, new Date());
  await connection.db.update(cloudInterfaces).set({ scanGeneration: 2 }).where(eq(cloudInterfaces.id, f.slot.interfaceId));
  await health.checkLocal(r!.id);
  expect((await connection.db.select().from(probeRounds).where(eq(probeRounds.id, r!.id)))[0]).toMatchObject({ status: "superseded", consensusResult: "unknown", localOutcome: null });
});
it("historical healthy state does not satisfy fresh authority until the success threshold is rebuilt", async () => {
  const f = await target();
  for (let i=0; i<2; i++) { const r = await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime()+i*15000)); await vote(r!.id, "success"); await health.closeRound(r!.id, r!.deadline); }
  const unknown = await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime()+30000)); await health.closeRound(unknown!.id, unknown!.deadline);
  const next = await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime()+45000)); await vote(next!.id, "success"); await health.closeRound(next!.id, next!.deadline);
  const [state] = await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.endpointId, f.endpoint.id));
  expect(state).toMatchObject({ healthState: "healthy", latestDecision: "success", consecutiveSuccesses: 1 });
  expect(hasFreshHealthEvidence(state!, "success", f.policy, next!.deadline)).toBe(false);
});

it("normalizes legacy local-slot cohorts and timestamps evidence expiry once", async () => {
 const slot = await slotTarget("local");
 await connection.db.update(addressHealthPolicies).set({ groupId: slot.group.id, consensus: { mode: "all", minimumValid: 2 } }).where(eq(addressHealthPolicies.id, slot.policy.id));
 const local = await scheduler.schedulePolicy(slot.policy.id, now);
 expect(local!.memberIds).toEqual(["local"]);
 expect(await connection.db.select().from(probeTasks).where(eq(probeTasks.roundId, local!.id))).toHaveLength(0);
 await health.recordLocal(local!.id, "success", new Date(now.getTime()+1000));
 expect(await health.closeRound(local!.id, local!.deadline)).toBe("success");
});
it("timestamps evidence expiry once for downstream notification deduplication", async () => {
 const f = await target(); const first = await scheduler.schedulePolicy(f.policy.id, now); await vote(first!.id, "success"); await health.closeRound(first!.id, first!.deadline);
 const expiry = new Date(now.getTime()+90000); await scheduler.schedulePolicy(f.policy.id, expiry);
 const [state] = await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.endpointId, f.endpoint.id));
 expect(state).toMatchObject({ latestDecision: "unknown", stateChangedAt: expiry });
 await scheduler.schedulePolicy(f.policy.id, new Date(expiry.getTime()+15000));
 expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.endpointId, f.endpoint.id)))[0]!.stateChangedAt).toEqual(expiry);
});

it.each(["external", "mixed"] as const)("keeps probing published DDNS current while a %s candidate fails", async mode => {
  const f = await fixture(connection.db, "ddns");
  const [current] = await connection.db.insert(endpointAddresses).values({ endpointId: f.endpoint.id, family: "4", address: "192.0.2.10", state: "current", source: "ddns", healthState: "healthy" }).returning();
  await connection.db.update(endpoints).set({ healthState: "healthy" }).where(eq(endpoints.id, f.endpoint.id));
  const [policy] = await connection.db.insert(addressHealthPolicies).values({ endpointId: f.endpoint.id, family: "4", configId: f.config.id, mode, groupId: f.group.id, consensus: { mode: "all", minimumValid: mode === "mixed" ? 3 : 2 }, successThreshold: 2, failureThreshold: 2 }).returning();
  const initial = await scheduler.schedulePolicy(policy!.id, now);
  let rounds = await connection.db.select().from(probeRounds).where(eq(probeRounds.endpointId, f.endpoint.id));
  expect(rounds.map(r => r.endpointAddressId).sort()).toEqual([current!.id, f.address.id].sort());
  for (let i = 0; i < 2; i++) {
    if (i) {
      await scheduler.schedulePolicy(policy!.id, new Date(now.getTime() + i * 15000));
      rounds = (await connection.db.select().from(probeRounds).where(eq(probeRounds.endpointId, f.endpoint.id))).filter(r => r.status === "pending");
    }
    // Close candidate first to prove its higher sequence does not suppress current evidence.
    rounds.sort((a, b) => Number(b.endpointAddressId === f.address.id) - Number(a.endpointAddressId === f.address.id));
    for (const r of rounds) {
      await vote(r.id, "failure");
      if (mode === "mixed") await health.recordLocal(r.id, "failure", new Date(r.deadline.getTime() - 1));
      await health.closeRound(r.id, r.deadline);
    }
  }
  expect(initial).toBeDefined();
  expect((await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.id, current!.id)))[0]).toMatchObject({ state: "current", healthState: "unhealthy", consecutiveFailures: 2 });
  expect((await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.id, f.address.id)))[0]).toMatchObject({ state: "candidate", healthState: "unhealthy", consecutiveFailures: 2 });
  expect((await connection.db.select().from(endpoints).where(eq(endpoints.id, f.endpoint.id)))[0]!.healthState).toBe("unhealthy");
  const intents = await connection.db.select().from(reconcileIntents).where(eq(reconcileIntents.poolId, f.pool.id));
  expect(intents.some(intent => intent.trigger === "failure")).toBe(true);
  const states = await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.endpointId, f.endpoint.id));
  expect(states).toHaveLength(2);
});

it("supersedes accepted old-round results after same-IP address recreation", async () => {
  const f = await target();
  const old = await scheduler.schedulePolicy(f.policy.id, now);
  await vote(old!.id, "success");
  await connection.db.update(endpointAddresses).set({ state: "previous" }).where(eq(endpointAddresses.id, f.address.id));
  const [replacement] = await connection.db.insert(endpointAddresses).values({ endpointId: f.endpoint.id, family: "4", address: f.address.address, state: "current", source: "static" }).returning();
  await scheduler.schedulePolicy(f.policy.id, new Date(now.getTime() + 1000));
  expect(await health.closeRound(old!.id, old!.deadline)).toBe("unknown");
  expect((await connection.db.select().from(probeRounds).where(eq(probeRounds.id, old!.id)))[0]!.status).toBe("superseded");
  expect((await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.id, replacement!.id)))[0]).toMatchObject({ healthState: "unknown", consecutiveSuccesses: 0 });
});
