import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { addressHealthPolicies, addressHealthStates, auditLogs, cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, createProbeRound, healthCheckConfigs, managedAddressSlots, probeObservations, probeObservationStats, probeRoundSequences, probeRounds, probeTasks, rotationIncidents, rotationPolicies, rotationSchedules, sessions } from "@masterdns/db";
import { hashToken } from "@masterdns/crypto";
import { AuthGuard, SESSION_COOKIE } from "../../auth/auth.guard.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { ApiExceptionFilter } from "../../common/api-exception.filter.js";
import { HealthPoliciesController } from "./health-policies.controller.js";
import { HealthPoliciesService } from "./health-policies.service.js";
import { fixture, testDatabase } from "./health-policy-test-utils.js";
import { ProbeLeasesService } from "./probe-leases.service.js";
import { ProbeResultsService } from "./probe-results.service.js";

let connection: Awaited<ReturnType<typeof testDatabase>>;
let service: HealthPoliciesService;
beforeAll(async () => { connection = await testDatabase(); service = new HealthPoliciesService({ db: connection.db } as never); }, 30000);
afterAll(async () => { await connection?.dispose(); });

async function endpointPolicy() {
  const f = await fixture(connection.db);
  const input = { endpointId: f.endpoint.id, family: "4", configId: f.config.id, mode: "external", groupId: f.group.id };
  const policy = await service.save(f.actor as AuthUser, input);
  return { ...f, input, policy };
}

async function slotPolicy() {
  const f = await fixture(connection.db);
  const [account] = await connection.db.insert(cloudAccounts).values({ ownerUserId: f.actor.id, provider: "aws", name: "test", credentialCiphertext: "test", credentialIv: "test", credentialTag: "test" }).returning();
  const [instance] = await connection.db.insert(cloudInstances).values({ accountId: account!.id, service: "ec2", region: "test", externalId: randomUUID(), scanGeneration: 1 }).returning();
  const [nic] = await connection.db.insert(cloudInterfaces).values({ instanceId: instance!.id, externalId: randomUUID(), scanGeneration: 1 }).returning();
  const [address] = await connection.db.insert(cloudAddresses).values({ interfaceId: nic!.id, kind: "host", family: "4", address: "192.0.2.20", origin: "user", scanGeneration: 1 }).returning();
  const [slot] = await connection.db.insert(managedAddressSlots).values({ interfaceId: nic!.id, family: "4", name: "primary", currentAddressId: address!.id, currentVersion: 1 }).returning();
  const config = await service.saveSlotConfig(f.actor as AuthUser, slot!.id, { config: { type: "tcp", port: 443 } });
  const policy = await service.save(f.actor as AuthUser, { slotId: slot!.id, family: "4", configId: config.id, mode: "external", groupId: f.group.id });
  return { ...f, slot: slot!, policy, config };
}

async function round(f: Awaited<ReturnType<typeof endpointPolicy>>) {
  const now = new Date();
  return connection.db.transaction(tx => createProbeRound(tx, f.actor, {
    endpointAddressId: f.address.id, configId: f.config.id, groupId: f.group.id,
    addressVersion: 1, policyId: f.policy.id, policyRevision: f.policy.revision,
    consensus: { mode: "all", minimumValid: 2 },
    deadline: new Date(now.getTime() + 10000), resultExpiresAt: new Date(now.getTime() + 60000),
  }, now));
}

it("deletes only one family policy, invalidates evidence and tasks, and preserves history and sequence", async () => {
  const f = await endpointPolicy();
  const ipv6 = await service.save(f.actor as AuthUser, { ...f.input, family: "6" });
  const completed = await round(f);
  await connection.db.update(probeRounds).set({ status: "completed", consensusResult: "success", finalizedAt: new Date() }).where(eq(probeRounds.id, completed.id));
  await connection.db.update(probeTasks).set({ status: "accepted" }).where(eq(probeTasks.roundId, completed.id));
  const pending = await round(f);
  const leases = new ProbeLeasesService({ db: connection.db } as never);
  const [leased] = await leases.lease(f.agents[0]!.id, 1);
  const [state] = await connection.db.insert(addressHealthStates).values({ endpointId: f.endpoint.id, family: "4", addressId: f.address.id, policyId: f.policy.id, policyRevision: 1, healthState: "healthy", latestDecision: "success", consecutiveSuccesses: 3, evidenceExpiresAt: new Date(Date.now() + 60000), lastAppliedSequence: 1 }).returning();
  const [otherState] = await connection.db.insert(addressHealthStates).values({ endpointId: f.endpoint.id, family: "6", addressId: randomUUID(), policyId: ipv6.id, healthState: "healthy" }).returning();
  await connection.db.insert(probeObservationStats).values({ targetKey: `endpoint:${f.endpoint.id}`, probeId: f.agents[0]!.id, family: "4", period: "day", bucketStart: new Date(), sampleCount: 1, successCount: 1, unavailableCount: 0 });

  expect(await service.remove(f.actor as AuthUser, f.policy.id, { expectedRevision: 1 })).toEqual({ deleted: true });
  expect(await service.list(f.actor as AuthUser)).toMatchObject([{ id: ipv6.id }]);
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.id, state!.id)))[0]).toMatchObject({ healthState: "unknown", latestDecision: "unknown", consecutiveSuccesses: 0, evidenceExpiresAt: null, nextRoundAt: null, lastAppliedSequence: 1 });
  expect((await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.id, otherState!.id)))[0]!.healthState).toBe("healthy");
  expect((await connection.db.select().from(probeRounds).where(eq(probeRounds.id, pending.id)))[0]).toMatchObject({ status: "superseded", consensusResult: "unknown" });
  expect((await connection.db.select().from(probeTasks).where(eq(probeTasks.roundId, pending.id))).map(task => task.status)).toEqual(["stale", "stale"]);
  expect((await connection.db.select().from(probeRounds).where(eq(probeRounds.id, completed.id)))[0]!.status).toBe("completed");
  expect((await connection.db.select().from(probeTasks).where(eq(probeTasks.roundId, completed.id))).every(task => task.status === "accepted")).toBe(true);
  expect(await connection.db.select().from(healthCheckConfigs).where(eq(healthCheckConfigs.id, f.config.id))).toHaveLength(1);
  expect(await connection.db.select().from(probeObservationStats).where(eq(probeObservationStats.targetKey, `endpoint:${f.endpoint.id}`))).toHaveLength(1);
  const [audit] = await connection.db.select().from(auditLogs).where(and(eq(auditLogs.resourceId, f.policy.id), eq(auditLogs.action, "health.policy.delete")));
  expect(audit).toMatchObject({ ownerUserId: f.actor.id, actorUserId: f.actor.id, beforeSnapshot: { id: f.policy.id }, afterSnapshot: null });
  expect(await leases.lease(f.agents[0]!.id, 1)).toEqual([]);
  const results = new ProbeResultsService({ db: connection.db } as never);
  expect(await results.accept(f.agents[0]!.id, { protocol: "probe-agent/v1", taskId: leased!.taskId, leaseId: leased!.leaseId, addressVersion: 1, configVersion: 1, outcome: "success", latencyMs: 1, measuredAt: new Date().toISOString() })).not.toBe("accepted");
  expect(await connection.db.select().from(probeObservations).where(eq(probeObservations.roundId, pending.id))).toEqual([]);
  const recreated = await service.save(f.actor as AuthUser, f.input);
  expect(recreated.id).not.toBe(f.policy.id);
  expect((await round({ ...f, policy: recreated })).sequence).toBe(3);
  expect((await connection.db.select().from(probeRoundSequences).where(eq(probeRoundSequences.endpointId, f.endpoint.id)))[0]!.lastSequence).toBe(3);
});

it("hides other owners' policies and lets an administrator delete with the original owner audit", async () => {
  const f = await endpointPolicy(); const stranger = await fixture(connection.db);
  await expect(service.remove(stranger.actor as AuthUser, f.policy.id, { expectedRevision: 1 })).rejects.toMatchObject({ status: 404 });
  expect(await connection.db.select().from(addressHealthPolicies).where(eq(addressHealthPolicies.id, f.policy.id))).toHaveLength(1);
  await service.remove({ ...stranger.actor, role: "admin" } as AuthUser, f.policy.id, { expectedRevision: 1 });
  expect((await connection.db.select().from(auditLogs).where(eq(auditLogs.action, "health.policy.delete"))).find(row => row.resourceId === f.policy.id)).toMatchObject({ ownerUserId: f.actor.id, actorUserId: stranger.actor.id });
  await expect(service.remove(f.actor as AuthUser, f.policy.id, { expectedRevision: 1 })).rejects.toMatchObject({ status: 404 });
});

it("rejects a stale revision without deleting the updated policy", async () => {
  const f = await endpointPolicy();
  await service.save(f.actor as AuthUser, { ...f.input, successThreshold: 4 });
  await expect(service.remove(f.actor as AuthUser, f.policy.id, { expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
  expect((await service.list(f.actor as AuthUser))[0]!.revision).toBe(2);
});

it.each(["health", "scheduled"] as const)("requires the %s rotation switch to be disabled before deleting a cloud policy", async kind => {
  const f = await slotPolicy();
  if (kind === "health") await connection.db.insert(rotationPolicies).values({ slotId: f.slot.id, enabled: true });
  else await connection.db.insert(rotationSchedules).values({ slotId: f.slot.id, enabled: true, pausedReason: "test" });
  await expect(service.remove(f.actor as AuthUser, f.policy.id, { expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
  if (kind === "health") await connection.db.update(rotationPolicies).set({ enabled: false }).where(eq(rotationPolicies.slotId, f.slot.id));
  else await connection.db.update(rotationSchedules).set({ enabled: false }).where(eq(rotationSchedules.slotId, f.slot.id));
  expect(await service.remove(f.actor as AuthUser, f.policy.id, { expectedRevision: 1 })).toEqual({ deleted: true });
  expect((await service.slotConfig(f.actor as AuthUser, f.slot.id))!.id).toBe(f.config.id);
});

it.each(["active", "paused", "exhausted"] as const)("retains cloud policies while a rotation is %s", async status => {
  const f = await slotPolicy();
  const [incident] = await connection.db.insert(rotationIncidents).values({ ownerUserId: f.actor.id, slotId: f.slot.id, family: "4", physicalKey: randomUUID(), sourceEventId: randomUUID(), trigger: "manual", status, currentSegmentId: randomUUID(), authorizationRevision: 1, policyRevision: 1, addressVersion: 1 }).returning();
  await expect(service.remove(f.actor as AuthUser, f.policy.id, { expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
  await connection.db.update(rotationIncidents).set({ status: "complete" }).where(eq(rotationIncidents.id, incident!.id));
  expect(await service.remove(f.actor as AuthUser, f.policy.id, { expectedRevision: 1 })).toEqual({ deleted: true });
});

it("does not wait for a probe task locked by an in-flight result", async () => {
  const f = await endpointPolicy(); const pending = await round(f);
  await connection.db.transaction(async tx => {
    await tx.select().from(probeTasks).where(eq(probeTasks.roundId, pending.id)).for("update");
    let timeout: ReturnType<typeof setTimeout>;
    try {
      expect(await Promise.race([
        service.remove(f.actor as AuthUser, f.policy.id, { expectedRevision: 1 }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Deletion waited for a locked probe task")), 2000); }),
      ])).toEqual({ deleted: true });
    } finally { clearTimeout(timeout!); }
  });
});

it("exposes DELETE with a required revision and returns validation and conflict errors", async () => {
  const f = await endpointPolicy();
  @Module({ controllers: [HealthPoliciesController], providers: [{ provide: HealthPoliciesService, useValue: service }] })
  class TestModule {}
  const app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), { logger: false });
  const token = randomUUID();
  await connection.db.insert(sessions).values({ userId: f.actor.id, tokenHash: hashToken(token), sessionVersion: 1, expiresAt: new Date(Date.now() + 60000) });
  await app.register(cookie);
  app.useGlobalGuards(new AuthGuard(new Reflector(), { db: connection.db } as never));
  app.useGlobalFilters(new ApiExceptionFilter());
  try {
    await app.init(); await app.getHttpAdapter().getInstance().ready();
    const url = `/v1/address-health-policies/${f.policy.id}`;
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    expect((await app.inject({ method: "DELETE", url, payload: { expectedRevision: 1 } })).statusCode).toBe(401);
    for (const payload of [{}, { expectedRevision: 0 }, { expectedRevision: 1, extra: true }]) {
      expect((await app.inject({ method: "DELETE", url, headers, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "DELETE", url, headers, payload: { expectedRevision: 2 } })).statusCode).toBe(409);
    const response = await app.inject({ method: "DELETE", url, headers, payload: { expectedRevision: 1 } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ deleted: true });
  } finally { await app.close(); }
});
