import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase, rotationLeases } from "@masterdns/db";
import { acquireRotationLease, releaseRotationLease, verifyRotationLease } from "./rotation-lock.js";
let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
const name = `rotation_${randomUUID().replaceAll("-", "")}`;
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  admin = createDatabase(root); await admin.client.unsafe(`create database "${name}"`);
  const url = new URL(root); url.pathname = `/${name}`; connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../packages/db/drizzle", import.meta.url).pathname });
});
afterAll(async () => { await connection?.close(); if (admin) { await admin.client.unsafe(`drop database if exists "${name}"`); await admin.close(); } });
it("serializes concurrent physical-instance claims and fences a stale holder after expiry", async () => {
  const key = JSON.stringify(["aws", "123456789012", "ec2", "us-east-1", "i-physical"]);
  const claims = await Promise.all(Array.from({ length: 8 }, () => connection.db.transaction(tx => acquireRotationLease(tx, key, randomUUID()))));
  expect(claims.filter(Boolean)).toHaveLength(1);
  const old = claims.find(Boolean)!;
  await connection.db.update(rotationLeases).set({ expiresAt: new Date(0) }).where(eq(rotationLeases.physicalKey, key));
  const next = await connection.db.transaction(tx => acquireRotationLease(tx, key, randomUUID()));
  expect(next!.revision).toBe(old.revision + 1);
  expect(await connection.db.transaction(tx => verifyRotationLease(tx, old))).toBeUndefined();
  await connection.db.transaction(tx => releaseRotationLease(tx, old));
  expect(await connection.db.transaction(tx => verifyRotationLease(tx, next!))).toBeDefined();
});

import { vi } from "vitest";
import { CloudError, Ec2CloudAdapter, type CloudAdapter, type CloudInventory, type CloudStepResult } from "@masterdns/cloud-providers";
import { addressHealthPolicies, addressHealthStates, cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, cloudScanScopes, createRotationIncident, healthCheckConfigs, instanceAuthorizations, lockRotationContext, managedAddressSlots, probeGroups, resumeRotationIncident, rotationAttempts, rotationBudgetSegments, rotationIncidents, rotationPolicies, rotationPublications, rotationResources, rotationSteps, rotationStepObservations, users } from "@masterdns/db";
vi.mock("../env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { RotationStore } from "./rotation-store.js";
import { RotationProcessor } from "./rotation.processor.js";
import { RotationRecoveryService } from "./rotation-recovery.service.js";

async function fixture(family: "4" | "6" = "4") {
  const [owner] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const [account] = await connection.db.insert(cloudAccounts).values({ ownerUserId: owner!.id, provider: "aws", name: "AWS", externalAccountId: "123456789012", credentialCiphertext: "encrypted-secret", credentialIv: "iv", credentialTag: "tag" }).returning();
  await connection.db.insert(cloudScanScopes).values({ accountId: account!.id, service: "ec2", region: "us-east-1", generation: 1 });
  const [instance] = await connection.db.insert(cloudInstances).values({ accountId: account!.id, service: "ec2", region: "us-east-1", externalId: `i-${randomUUID()}`, metadata: { present: true }, scanGeneration: 1 }).returning();
  const [iface] = await connection.db.insert(cloudInterfaces).values({ instanceId: instance!.id, externalId: `eni-${randomUUID()}`, metadata: { deviceIndex: 0 }, scanGeneration: 1 }).returning();
  const [address] = await connection.db.insert(cloudAddresses).values({ interfaceId: iface!.id, family, kind: "host", address: family === "4" ? "192.0.2.10" : "2001:db8::1", remoteAllocationId: family === "4" ? "eipalloc-old" : null, origin: "user", scanGeneration: 1 }).returning();
  const [slot] = await connection.db.insert(managedAddressSlots).values({ interfaceId: iface!.id, family, name: "primary", currentAddressId: address!.id, currentVersion: 1 }).returning();
  await connection.db.insert(instanceAuthorizations).values({ instanceId: instance!.id, managed: true, allowIpv4Rotation: true, allowIpv6Rotation: true });
  const [config] = await connection.db.insert(healthCheckConfigs).values({ slotId: slot!.id, checkerType: "tcp", config: { port: 443 } }).returning();
  const [group] = await connection.db.insert(probeGroups).values({ ownerUserId: owner!.id, name: "external" }).returning();
  const [healthPolicy] = await connection.db.insert(addressHealthPolicies).values({ slotId: slot!.id, family, configId: config!.id, groupId: group!.id }).returning();
  await connection.db.insert(rotationPolicies).values({ slotId: slot!.id, enabled: true });
  const [health] = await connection.db.insert(addressHealthStates).values({ slotId: slot!.id, family, addressId: address!.id, addressVersion: 1, configId: config!.id, configVersion: 1, policyId: healthPolicy!.id, policyRevision: 1, groupRevision: 1, healthState: "unhealthy", latestDecision: "failure", consecutiveFailures: 3, lastRoundId: randomUUID(), lastCheckedAt: new Date(), evidenceExpiresAt: new Date(Date.now() + 60000) }).returning();
  const db = connection.db;
  const incident = await db.transaction(async tx => createRotationIncident(tx, await lockRotationContext(tx, slot!.id), `health-${health!.lastRoundId}-1`));
  const state = { writes: [] as string[], observations: [] as string[], effect: undefined as CloudStepResult | undefined, error: undefined as CloudError | undefined, repeated: false, lostResponse: false, count: 0, observationStatus: "applied" as "applied" | "pending" | "ambiguous" };
  const inventory: CloudInventory = { ref: { accountId: account!.id, service: "ec2", region: "us-east-1", instanceId: instance!.externalId }, name: "test", state: "running", interfaces: [{ id: iface!.externalId, deviceIndex: 0, addresses: [{ address: address!.address, family: Number(family) as 4 | 6, primary: family === "4", ...(family === "4" ? { allocationId: "eipalloc-old", privateAddress: "10.0.0.1" } : {}) }] }] };
  const adapter: CloudAdapter = {
    verifyIdentity: async () => ({ externalAccountId: account!.externalAccountId! }), listScopes: async () => ["us-east-1"], discover: async () => ({ items: [inventory] }), inspect: async () => structuredClone(inventory), capabilities: () => ({ available: true, permission: "unverified", requiresStop: false, releasesOldAddress: false, canRestoreOldAddress: true }),
    execute: async step => {
      state.writes.push(step.id);
      if (state.error) throw state.error;
      if (step.action.endsWith("allocate") || step.action.endsWith("assign")) {
        state.count++; state.effect = { candidateAddress: state.repeated ? address!.address : family === "4" ? `198.51.100.${state.count}` : `2001:db8::${state.count + 1}`, ...(family === "4" ? { allocationId: `eipalloc-${state.count}` } : {}), candidateRepeated: state.repeated };
      }
      if (step.action.endsWith("associate") || step.action.endsWith("assign")) inventory.interfaces[0]!.addresses = [{ ...inventory.interfaces[0]!.addresses[0]!, address: state.effect!.candidateAddress!, ...(state.effect!.allocationId ? { allocationId: state.effect!.allocationId } : {}) }];
      if (state.lostResponse) throw new CloudError("temporary_cloud_error", true);
      return state.effect!;
    },
    observe: async () => state.observationStatus,
    observeDetails: async step => { state.observations.push(step.id); return { ...state.effect, status: family === "6" && !step.arguments.receipt ? "ambiguous" : state.observationStatus }; },
  };
  const store = new RotationStore({ db } as never);
  const runtime = { adapter: async () => adapter };
  const processor = new RotationProcessor(store, runtime as never, {} as never);
  return { owner: owner!, account: account!, instance: instance!, iface: iface!, address: address!, slot: slot!, config: config!, group: group!, healthPolicy: healthPolicy!, health: health!, incident, state, inventory, adapter, store, runtime, processor };
}
async function drive(f: Awaited<ReturnType<typeof fixture>>, turns = 5) { for (let n = 0; n < turns; n++) await f.processor.run(f.incident.id); }
async function evidence(f: Awaited<ReturnType<typeof fixture>>, decision: "success" | "failure" | "unknown", version?: number) {
  const [slot] = await connection.db.select().from(managedAddressSlots).where(eq(managedAddressSlots.id, f.slot.id));
  await connection.db.update(addressHealthStates).set({ addressId: slot!.candidateAddressId ?? slot!.currentAddressId, addressVersion: version ?? (slot!.candidateAddressId ? slot!.candidateVersion : slot!.currentVersion), healthState: decision === "success" ? "healthy" : decision === "failure" ? "unhealthy" : "unknown", latestDecision: decision, consecutiveFailures: decision === "failure" ? 3 : 0, consecutiveSuccesses: decision === "success" ? 3 : 0, lastAppliedSequence: 10, lastCheckedAt: new Date(), evidenceExpiresAt: new Date(Date.now() + 60000), lastRoundId: randomUUID() }).where(eq(addressHealthStates.id, f.health.id));
}
it("commits a plan before effects, persists receipts and requires fresh exact-version external consensus before publication", async () => {
  const f = await fixture();
  await drive(f, 1);
  expect(f.state.writes).toHaveLength(0);
  expect(await connection.db.select().from(rotationSteps).where(eq(rotationSteps.attemptId, (await connection.db.select().from(rotationAttempts).where(eq(rotationAttempts.incidentId, f.incident.id)))[0]!.id))).toHaveLength(2);
  await drive(f, 4);
  const [slot] = await connection.db.select().from(managedAddressSlots).where(eq(managedAddressSlots.id, f.slot.id));
  expect(slot).toMatchObject({ currentAddressId: f.address.id, currentVersion: 1, candidateVersion: 2 });
  const [health] = await connection.db.select().from(addressHealthStates).where(eq(addressHealthStates.id, f.health.id));
  expect(health).toMatchObject({ latestDecision: "unknown", consecutiveFailures: 0 });
  await evidence(f, "success", 1); await drive(f, 1);
  expect(await connection.db.select().from(rotationPublications).where(eq(rotationPublications.incidentId, f.incident.id))).toHaveLength(0);
  await evidence(f, "success"); await drive(f, 1);
  expect(await connection.db.select().from(rotationPublications).where(eq(rotationPublications.incidentId, f.incident.id))).toMatchObject([{ status: "pending", addressVersion: 2 }]);
  expect((await connection.db.select().from(rotationIncidents).where(eq(rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ phase: "publish", status: "active" });
  expect(f.state.writes).toHaveLength(2);
  expect(await connection.db.select().from(rotationResources).where(eq(rotationResources.incidentId, f.incident.id))).toHaveLength(2);
});
it("recovers a lost response by observing the original step, preserving its attempt and budget", async () => {
  const f = await fixture(); await drive(f, 1); f.state.lostResponse = true; await drive(f, 1);
  const [attempt] = await connection.db.select().from(rotationAttempts).where(eq(rotationAttempts.incidentId, f.incident.id));
  const recovered = new RotationProcessor(new RotationStore({ db: connection.db } as never), f.runtime as never, {} as never);
  await recovered.run(f.incident.id);
  expect(f.state.writes).toHaveLength(1); expect(f.state.observations).toHaveLength(1);
  expect((await connection.db.select().from(rotationAttempts).where(eq(rotationAttempts.incidentId, f.incident.id)))[0]).toMatchObject({ id: attempt!.id, charged: true });
  expect((await connection.db.select().from(rotationBudgetSegments).where(eq(rotationBudgetSegments.incidentId, f.incident.id)))[0]!.attemptsUsed).toBe(1);
});
it("retains IPv6 uncertainty after lease expiry and blocks both replay and a new budget segment", async () => {
  const f = await fixture("6"); await drive(f, 1); f.state.lostResponse = true; await drive(f, 2);
  const [lease] = await connection.db.select().from(rotationLeases).where(eq(rotationLeases.physicalKey, f.incident.physicalKey));
  expect(lease!.unresolvedStepId).toBeTruthy();
  expect((await connection.db.select().from(rotationSteps).where(eq(rotationSteps.id, lease!.unresolvedStepId!)))[0]!.status).toBe("ambiguous");
  await connection.db.update(rotationLeases).set({ expiresAt: new Date(0) }).where(eq(rotationLeases.physicalKey, lease!.physicalKey));
  await drive(f, 3); expect(f.state.writes).toHaveLength(1);
  await expect(connection.db.transaction(async tx => resumeRotationIncident(tx, await lockRotationContext(tx, f.slot.id), f.incident.id, f.owner.id))).rejects.toThrow("cloud_observation_required");
});
it("refunds only a confirmed no-effect rejection and never refunds uncertain transport failure", async () => {
  const f = await fixture(); f.state.error = new CloudError("quota_exceeded", false); await drive(f, 2);
  expect((await connection.db.select().from(rotationBudgetSegments).where(eq(rotationBudgetSegments.incidentId, f.incident.id)))[0]).toMatchObject({ attemptsUsed: 0 });
  expect((await connection.db.select().from(rotationSteps).where(eq(rotationSteps.id, f.state.writes[0]!)))[0]).toMatchObject({ status: "rejected_no_effect", errorCode: "quota_exceeded" });
  const g = await fixture(); g.state.lostResponse = true; await drive(g, 2);
  expect((await connection.db.select().from(rotationBudgetSegments).where(eq(rotationBudgetSegments.incidentId, g.incident.id)))[0]).toMatchObject({ attemptsUsed: 1 });
});
it("rechecks authorization and configuration after adapter creation and before dispatch", async () => {
  const f = await fixture(); await drive(f, 1);
  f.runtime.adapter = async () => { await connection.db.update(instanceAuthorizations).set({ managed: false, revision: 2 }).where(eq(instanceAuthorizations.instanceId, f.instance.id)); return f.adapter; };
  await drive(f, 1); expect(f.state.writes).toHaveLength(0);
  const g = await fixture(); await drive(g, 1);
  g.runtime.adapter = async () => { await connection.db.update(healthCheckConfigs).set({ revision: 2 }).where(eq(healthCheckConfigs.id, g.config.id)); return g.adapter; };
  await drive(g, 1); expect(g.state.writes).toHaveLength(0);
});
it("latches three actual candidate failures across repeated health events and supports fresh natural recovery", async () => {
  const f = await fixture();
  for (let attempt = 0; attempt < 3; attempt++) {
    await drive(f, 5); await evidence(f, "failure");
    await connection.db.update(rotationIncidents).set({ nextAttemptAt: new Date(0) }).where(eq(rotationIncidents.id, f.incident.id));
  }
  await drive(f, 1);
  for (let n = 0; n < 100; n++) await connection.db.transaction(async tx => createRotationIncident(tx, await lockRotationContext(tx, f.slot.id), `health-delivery-${n}`));
  expect(await connection.db.select().from(rotationAttempts).where(eq(rotationAttempts.incidentId, f.incident.id))).toHaveLength(3);
  expect((await connection.db.select().from(rotationIncidents).where(eq(rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ status: "exhausted" });
  expect((await connection.db.select().from(rotationBudgetSegments).where(eq(rotationBudgetSegments.incidentId, f.incident.id)))[0]).toMatchObject({ attemptsUsed: 3, exhausted: true });
  await evidence(f, "success"); await drive(f, 1);
  expect(await connection.db.select().from(rotationPublications).where(eq(rotationPublications.incidentId, f.incident.id))).toMatchObject([{ status: "pending", addressVersion: 4 }]);
});
it("manual resume appends a budget segment, retains history and preserves the candidate version", async () => {
  const f = await fixture(); await drive(f, 5); await evidence(f, "failure");
  await connection.db.update(rotationIncidents).set({ status: "paused", pausedByUserId: f.owner.id }).where(eq(rotationIncidents.id, f.incident.id));
  await drive(f, 2); expect(f.state.writes).toHaveLength(2);
  const resumed = await connection.db.transaction(async tx => resumeRotationIncident(tx, await lockRotationContext(tx, f.slot.id), f.incident.id, f.owner.id));
  expect(resumed.currentSegmentId).not.toBe(f.incident.currentSegmentId); expect(resumed.addressVersion).toBe(2);
  expect(await connection.db.select().from(rotationBudgetSegments).where(eq(rotationBudgetSegments.incidentId, f.incident.id))).toHaveLength(2);
  expect(await connection.db.select().from(rotationAttempts).where(eq(rotationAttempts.incidentId, f.incident.id))).toHaveLength(1);
});
it("blocks another credential alias while an accepted step remains uncertain even after management is revoked", async () => {
  const f = await fixture(); await drive(f, 1); f.state.lostResponse = true; await drive(f, 1);
  const g = await fixture();
  await connection.db.update(cloudInstances).set({ externalId: f.instance.externalId }).where(eq(cloudInstances.id, g.instance.id));
  await connection.db.update(rotationIncidents).set({ physicalKey: f.incident.physicalKey }).where(eq(rotationIncidents.id, g.incident.id));
  await connection.db.update(instanceAuthorizations).set({ managed: false, revision: 2 }).where(eq(instanceAuthorizations.instanceId, f.instance.id));
  await connection.db.update(rotationLeases).set({ expiresAt: new Date(0) }).where(eq(rotationLeases.physicalKey, f.incident.physicalKey));
  await drive(g, 2); expect(g.state.writes).toHaveLength(0);
  await drive(f, 1); expect(f.state.observations).toHaveLength(1);
});
it("detects conflicting active credential aliases without exposing the other owner", async () => {
  const f = await fixture(); const g = await fixture();
  await connection.db.update(cloudInstances).set({ externalId: f.instance.externalId }).where(eq(cloudInstances.id, g.instance.id));
  await drive(f, 1);
  expect(f.state.writes).toHaveLength(0);
  expect((await connection.db.select().from(rotationIncidents).where(eq(rotationIncidents.id, f.incident.id)))[0]!.errorCode).toBe("conflicting_manager");
});
it("serializes IPv4 and IPv6 plans for the same physical instance", async () => {
  const f = await fixture(); const g = await fixture("6");
  await connection.db.update(cloudInterfaces).set({ instanceId: f.instance.id }).where(eq(cloudInterfaces.id, g.iface.id));
  await connection.db.update(probeGroups).set({ ownerUserId: f.owner.id }).where(eq(probeGroups.id, g.group.id));
  await connection.db.update(rotationIncidents).set({ physicalKey: f.incident.physicalKey }).where(eq(rotationIncidents.id, g.incident.id));
  await drive(f, 2); await drive(g, 2);
  expect(f.state.writes).toHaveLength(1); expect(g.state.writes).toHaveLength(0);
});
it("preserves immutable allocation receipt identity rather than refreshing it on a conflicting observation", async () => {
  const f = await fixture(); await drive(f, 2); const stepId = f.state.writes[0]!;
  await f.store.saveReceipt(f.incident.id, stepId, { resourceId: "arn:aws:lightsail:original", candidateAddress: "198.51.100.1", status: "pending" } as never, true);
  await f.store.saveReceipt(f.incident.id, stepId, { resourceId: "arn:aws:lightsail:recreated", candidateAddress: "198.51.100.1", status: "applied" } as never, true);
  const [step] = await connection.db.select().from(rotationSteps).where(eq(rotationSteps.id, stepId));
  expect(step).toMatchObject({ status: "ambiguous", receipt: { resourceId: "arn:aws:lightsail:original" } });
  expect(await connection.db.select().from(rotationStepObservations).where(eq(rotationStepObservations.stepId, stepId))).toHaveLength(3);
});
it("uses actual AWS adapter commands with a fake SDK and never issues a second IPv6 assignment after persistence fails", async () => {
  const f = await fixture("6");
  const ipv6 = [{ Ipv6Address: f.address.address, IsPrimaryIpv6: false }];
  const writes: string[] = [];
  const sdk = new Ec2CloudAdapter(f.account.id, { kind: "access_key", accessKeyId: "fake", secretAccessKey: "fake" }, {
    stsSend: async () => ({ Account: "123456789012" }),
    ec2Send: async command => {
      if (command.constructor.name === "DescribeInstancesCommand") return { Reservations: [{ Instances: [{ InstanceId: f.instance.externalId, State: { Name: "running" } }] }] };
      if (command.constructor.name === "DescribeNetworkInterfacesCommand") return { NetworkInterfaces: [{ NetworkInterfaceId: f.iface.externalId, Attachment: { InstanceId: f.instance.externalId, DeviceIndex: 0 }, Ipv6Addresses: ipv6 }] };
      writes.push(command.constructor.name);
      if (command.constructor.name === "AssignIpv6AddressesCommand") { ipv6.push({ Ipv6Address: "2001:db8::2", IsPrimaryIpv6: false }); return { AssignedIpv6Addresses: ["2001:db8::2"] }; }
      throw new Error("Unexpected cloud write");
    },
  });
  f.runtime.adapter = async () => sdk;
  const save = vi.spyOn(f.store, "saveReceipt").mockRejectedValueOnce(new Error("simulated database disconnect after SDK effect"));
  await drive(f, 2); save.mockRestore(); await drive(f, 2);
  expect(writes).toEqual(["AssignIpv6AddressesCommand"]);
  expect((await connection.db.select().from(rotationIncidents).where(eq(rotationIncidents.id, f.incident.id)))[0]!.errorCode).toBe("resource_ownership_ambiguous");
  expect((await connection.db.select().from(rotationBudgetSegments).where(eq(rotationBudgetSegments.incidentId, f.incident.id)))[0]!.attemptsUsed).toBe(1);
});
it("recovers durable due work after a lost queue wakeup without creating a second incident", async () => {
  const f = await fixture(); const jobs: string[] = [];
  const recovery = new RotationRecoveryService({ db: connection.db } as never, { rotation: { add: async (_name: string, data: { incidentId: string }) => { jobs.push(data.incidentId); } } } as never);
  await recovery.recover(); await recovery.recover();
  expect(jobs.filter(id => id === f.incident.id)).toHaveLength(2);
  expect(await connection.db.select().from(rotationIncidents).where(eq(rotationIncidents.slotId, f.slot.id))).toHaveLength(1);
});
it("completes a recovered current address before any effect without charging or publishing a fake candidate", async () => {
  const f = await fixture(); await evidence(f, "success"); await drive(f, 1);
  expect(f.state.writes).toHaveLength(0);
  expect((await connection.db.select().from(rotationIncidents).where(eq(rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ status: "complete", phase: "complete" });
  expect(await connection.db.select().from(rotationPublications).where(eq(rotationPublications.incidentId, f.incident.id))).toHaveLength(0);
  expect((await connection.db.select().from(rotationBudgetSegments).where(eq(rotationBudgetSegments.incidentId, f.incident.id)))[0]!.attemptsUsed).toBe(0);
});
it("finishes a resolved partial plan under its original segment before activating the manual budget extension", async () => {
  const f = await fixture(); await drive(f, 3);
  await connection.db.update(rotationIncidents).set({ status: "paused", pausedByUserId: f.owner.id }).where(eq(rotationIncidents.id, f.incident.id));
  const resumed = await connection.db.transaction(async tx => resumeRotationIncident(tx, await lockRotationContext(tx, f.slot.id), f.incident.id, f.owner.id));
  expect(resumed.currentSegmentId).toBe(f.incident.currentSegmentId); expect(resumed.pendingSegmentId).toBeTruthy();
  await drive(f, 2);
  const [incident] = await connection.db.select().from(rotationIncidents).where(eq(rotationIncidents.id, f.incident.id));
  expect(incident).toMatchObject({ phase: "candidate", currentSegmentId: resumed.pendingSegmentId, pendingSegmentId: null });
  expect((await connection.db.select().from(rotationBudgetSegments).where(eq(rotationBudgetSegments.id, resumed.pendingSegmentId!)))[0]!.attemptsUsed).toBe(0);
  expect(f.state.writes).toHaveLength(2);
});
