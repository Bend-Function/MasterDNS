import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import * as db from "@masterdns/db";
import { CloudError } from "@masterdns/cloud-providers";
vi.mock("../env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { fixture } from "./rotation-test-utils.js";
import { RotationCleanupService } from "./rotation-cleanup.service.js";
import { RotationPublicationService } from "./rotation-publication.service.js";
import { RotationProcessor } from "./rotation.processor.js";
import { RotationResetRecoveryService } from "./rotation-reset-recovery.service.js";
import { RotationStore } from "./rotation-store.js";

async function failedFixture() {
  const f = await fixture("4", "lightsail");
  await f.d.update(db.managedAddressSlots).set({ name: "primary-public", currentVersion: 1, candidateAddressId: null }).where(eq(db.managedAddressSlots.id, f.slot.id));
  await f.d.update(db.cloudAddresses).set({ metadata: { providerMetadata: { awsAddressScope: "public" } } }).where(eq(db.cloudAddresses.id, f.address.id));
  await f.d.update(db.instanceAuthorizations).set({ allowIpv4Rotation: true }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  await f.d.insert(db.rotationPolicies).values({ slotId: f.slot.id, enabled: true });
  await f.d.update(db.addressHealthStates).set({ latestDecision: "failure", healthState: "unhealthy", consecutiveFailures: 3, consecutiveSuccesses: 0 }).where(eq(db.addressHealthStates.slotId, f.slot.id));
  const incident = await f.d.transaction(async tx => db.createRotationIncident(tx, await db.lockRotationContext(tx, f.slot.id), randomUUID()));
  await f.d.update(db.rotationIncidents).set({ errorCode: "cloud_convergence_timeout", recoveryRetryAt: new Date(0), recoveryRetries: 1 }).where(eq(db.rotationIncidents.id, incident.id));
  const state = { inspections: 0, writes: 0, fail: false };
  f.live.interfaces[0]!.addresses[0] = { address: "198.51.100.20", family: 4, primary: true, metadata: { awsAddressScope: "public" } } as never;
  const adapter = { verifyIdentity: async () => ({ externalAccountId: f.account.externalAccountId! }), inspect: async () => { state.inspections++; if (state.fail) throw new CloudError("temporary_cloud_error", true); return structuredClone(f.live); }, execute: async () => { state.writes++; throw new Error("must_not_replay_old_step"); }, observeDetails: async () => ({ status: "pending" }) };
  const runtime = { adapter: async () => adapter };
  const store = new RotationStore({ db: f.d } as never);
  const processor = new RotationProcessor(store, runtime as never, {} as never, undefined, undefined, new RotationResetRecoveryService({ db: f.d } as never, runtime as never));
  return { ...f, incident, state, runtime, processor, store };
}

it("ends the failed task by syncing and resetting local state, preserves auto rotation and verifies the actual cloud IP", async () => {
  const f = await failedFixture();
  await f.processor.run(f.incident.id);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ status: "complete", errorCode: "cloud_state_reset" });
  const [slot] = await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id));
  const [address] = await f.d.select().from(db.cloudAddresses).where(eq(db.cloudAddresses.id, slot!.currentAddressId!));
  expect(address!.address).toBe("198.51.100.20");
  expect(slot).toMatchObject({ currentVersion: 0, candidateVersion: 2, candidateAddressId: address!.id });
  expect((await f.d.select().from(db.addressHealthStates).where(eq(db.addressHealthStates.slotId, f.slot.id)))[0]).toMatchObject({ latestDecision: "unknown", consecutiveSuccesses: 0, consecutiveFailures: 0 });
  expect((await f.d.select().from(db.rotationPolicies).where(eq(db.rotationPolicies.slotId, f.slot.id)))[0]!.enabled).toBe(true);
  expect(f.state.writes).toBe(0);
  await f.processor.run(f.incident.id);
  expect(f.state.inspections).toBe(1);
});

it("does not clear local state when cloud synchronization fails and caps retries across worker restarts", async () => {
  const f = await failedFixture();
  f.state.fail = true;
  for (let n = 1; n <= 6; n++) {
    const restarted = new RotationResetRecoveryService({ db: f.d } as never, f.runtime as never);
    await restarted.recover(f.incident.id);
    const [incident] = await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id));
    expect(incident!.recoveryRetries).toBe(Math.min(n, 5));
    expect(incident!.terminatedAt).toBeNull();
    expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]).toMatchObject({ currentAddressId: f.address.id, currentVersion: 1 });
    await f.d.update(db.rotationIncidents).set({ recoveryRetryAt: new Date(0) }).where(eq(db.rotationIncidents.id, f.incident.id));
  }
  expect(f.state.inspections).toBe(5);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ status: "exhausted", errorCode: "recovery_retries_exhausted" });
});

it("carries the five-reset budget across newly admitted incidents instead of retrying forever", async () => {
  const f = await failedFixture();
  let incident = f.incident;
  for (let n = 1; n <= 5; n++) {
    await new RotationResetRecoveryService({ db: f.d } as never, f.runtime as never).recover(incident.id);
    expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, incident.id)))[0]).toMatchObject({ status: "complete", recoveryRetries: n, errorCode: "cloud_state_reset" });
    const [slot] = await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id));
    await f.d.update(db.addressHealthStates).set({ addressId: slot!.candidateAddressId, addressVersion: slot!.candidateVersion, latestDecision: "failure", healthState: "unhealthy", consecutiveFailures: 3, lastCheckedAt: new Date(), evidenceExpiresAt: new Date(Date.now() + 60000) }).where(eq(db.addressHealthStates.slotId, f.slot.id));
    incident = await f.d.transaction(async tx => db.createRotationIncident(tx, await db.lockRotationContext(tx, f.slot.id), randomUUID()));
    expect(incident.recoveryRetries).toBe(n);
    await f.d.update(db.rotationIncidents).set({ errorCode: "cloud_operation_failed", recoveryRetryAt: null }).where(eq(db.rotationIncidents.id, incident.id));
  }
  await new RotationResetRecoveryService({ db: f.d } as never, f.runtime as never).recover(incident.id);
  expect(f.state.inspections).toBe(5);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, incident.id)))[0]).toMatchObject({ status: "exhausted", recoveryRetries: 5 });
});

it.each(["disabled", "paused", "terminated", "revoked", "zero budget"])("does not reset or enable rotation after %s", async mode => {
  const f = await failedFixture();
  if (mode === "disabled") await f.d.update(db.rotationPolicies).set({ enabled: false }).where(eq(db.rotationPolicies.slotId, f.slot.id));
  if (mode === "paused") await f.d.update(db.rotationIncidents).set({ status: "paused", pausedByUserId: f.account.ownerUserId }).where(eq(db.rotationIncidents.id, f.incident.id));
  if (mode === "terminated") await f.d.transaction(tx => db.terminateRotationIncident(tx, f.incident.id, f.account.ownerUserId));
  if (mode === "revoked") await f.d.update(db.instanceAuthorizations).set({ managed: false }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  if (mode === "zero budget") await f.d.update(db.rotationPolicies).set({ maxRecoveryRetries: 0 }).where(eq(db.rotationPolicies.slotId, f.slot.id));
  await new RotationResetRecoveryService({ db: f.d } as never, f.runtime as never).recover(f.incident.id);
  expect(f.state.inspections).toBe(0);
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]).toMatchObject({ currentVersion: 1, resetRecoveryRetries: 0 });
});

it("serializes concurrent resets and does not double charge or repeat inspection", async () => {
  const f = await failedFixture();
  await Promise.all(Array.from({ length: 4 }, () => new RotationResetRecoveryService({ db: f.d } as never, f.runtime as never).recover(f.incident.id)));
  expect(f.state.inspections).toBe(1);
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]!.resetRecoveryRetries).toBe(1);
});

it("abandons the unresolved old step and keeps its late receipt from restoring stale state", async () => {
  const f = await failedFixture();
  const [attempt] = await f.d.insert(db.rotationAttempts).values({ id: randomUUID(), incidentId: f.incident.id, segmentId: f.incident.currentSegmentId, sequence: 1, beforeInventory: {} }).returning();
  const [step] = await f.d.insert(db.rotationSteps).values({ id: randomUUID(), attemptId: attempt!.id, sequence: 0,
    status: "pending", fence: 1, plan: { id: "old", action: "lightsail.static-ip.attach", resourceKey: "old", arguments: {}, destructive: true } }).returning();
  await f.d.update(db.rotationIncidents).set({ currentAttemptId: attempt!.id }).where(eq(db.rotationIncidents.id, f.incident.id));
  await f.d.insert(db.rotationLeases).values({ physicalKey: f.incident.physicalKey, incidentId: f.incident.id, unresolvedStepId: step!.id });
  await f.processor.run(f.incident.id);
  await f.store.saveReceipt(f.incident.id, step!.id, { candidateAddress: "192.0.2.99" }, false, 1);
  expect((await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, step!.id)))[0]!.status).toBe("abandoned");
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.unresolvedStepId).toBeNull();
  expect(await f.d.select().from(db.rotationStepObservations).where(eq(db.rotationStepObservations.stepId, step!.id))).toHaveLength(1);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]!.status).toBe("complete");
});

it("recovers on the next run after a real runtime failure instead of replaying preparation", async () => {
  const f = await failedFixture();
  await f.d.update(db.rotationIncidents).set({ errorCode: null, recoveryRetryAt: null, recoveryRetries: 0 }).where(eq(db.rotationIncidents.id, f.incident.id));
  const runtime = f.runtime.adapter;
  f.runtime.adapter = async () => { throw new CloudError("temporary_cloud_error", true); };
  await f.processor.run(f.incident.id);
  f.runtime.adapter = runtime;
  await f.processor.run(f.incident.id);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ status: "complete", errorCode: "cloud_state_reset", recoveryRetries: 1 });
  expect(f.state.writes).toBe(0);
});

it("does not reset while another family has an active task", async () => {
  const f = await failedFixture();
  const [slot] = await f.d.insert(db.managedAddressSlots).values({ interfaceId: f.slot.interfaceId, family: "6", name: "v6" }).returning();
  await f.d.insert(db.rotationIncidents).values({ ownerUserId: f.account.ownerUserId, slotId: slot!.id, family: "6", trigger: "manual", status: "paused", pausedByUserId: f.account.ownerUserId,
    physicalKey: f.incident.physicalKey, sourceEventId: randomUUID(), currentSegmentId: randomUUID(), authorizationRevision: 1, policyRevision: 1, addressVersion: 1 });
  await f.processor.run(f.incident.id);
  expect(f.state.inspections).toBe(0);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]!.terminatedAt).toBeNull();
});

it("does not finish a reset after rotation is disabled during cloud identity verification", async () => {
  const f = await failedFixture();
  const adapter = f.runtime.adapter;
  f.runtime.adapter = async () => {
    await f.d.update(db.rotationPolicies).set({ enabled: false, revision: 2 }).where(eq(db.rotationPolicies.slotId, f.slot.id));
    return adapter();
  };
  await f.processor.run(f.incident.id);
  expect(f.state.inspections).toBe(0);
  expect((await f.d.select().from(db.rotationPolicies).where(eq(db.rotationPolicies.slotId, f.slot.id)))[0]!.enabled).toBe(false);
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]!.currentVersion).toBe(1);
});

it.each(["adapter", "inspect"])("releases a hung %s synchronization within the configured cloud timeout", async stage => {
  const f = await failedFixture();
  await f.d.update(db.rotationPolicies).set({ cloudWaitSeconds: 10 }).where(eq(db.rotationPolicies.slotId, f.slot.id));
  const adapter = await f.runtime.adapter();
  f.runtime.adapter = stage === "adapter" ? async () => new Promise<never>(() => {}) : async () => ({ ...adapter, inspect: async () => new Promise<never>(() => {}) });
  const began = Date.now();
  await f.processor.run(f.incident.id);
  expect(Date.now() - began).toBeLessThan(13000);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ status: "active", errorCode: "cloud_reset_sync_failed", lastRecoveryError: "rotation_call_timeout", recoveryRetries: 1, terminatedAt: null });
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.holder).toBeNull();
}, 15000);

it.each(["cleanup", "publication"])("routes the independent %s scanner through sync/reset before retrying old work", async phase => {
  const f = await failedFixture();
  await f.d.update(db.rotationIncidents).set({ phase: phase === "cleanup" ? "cleanup" : "publish", errorCode: phase === "cleanup" ? "cleanup_failed" : "dns_partial" }).where(eq(db.rotationIncidents.id, f.incident.id));
  const reset = new RotationResetRecoveryService({ db: f.d } as never, f.runtime as never);
  if (phase === "cleanup") {
    const [attempt] = await f.d.insert(db.rotationAttempts).values({ id: randomUUID(), incidentId: f.incident.id, segmentId: f.incident.currentSegmentId, sequence: 1, beforeInventory: {} }).returning();
    const [resource] = await f.d.insert(db.rotationResources).values({ incidentId: f.incident.id, attemptId: attempt!.id, address: f.address.address, origin: "user", role: "original", snapshot: {}, cleanupStatus: "failed", cleanupError: "cleanup_failed" }).returning();
    await new RotationCleanupService({ db: f.d } as never, f.runtime as never, reset).run(resource!.id, new Date());
    expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, resource!.id)))[0]).toMatchObject({ cleanupStatus: "retained", cleanupError: "cloud_state_reset" });
  } else {
    const [publication] = await f.d.insert(db.rotationPublications).values({ slotId: f.slot.id, incidentId: f.incident.id, addressVersion: 1, addressId: f.address.id, status: "failed", errorCode: "dns_partial" }).returning();
    await new RotationPublicationService({ db: f.d } as never, f.runtime as never, reset).observe(publication!.id);
    expect((await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.id, publication!.id)))[0]!.errorCode).toBe("manual_terminated");
  }
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ status: "complete", errorCode: "cloud_state_reset" });
  expect(f.state.writes).toBe(0);
});

it("ends the retry chain only after the refreshed healthy address is published", async () => {
  const f = await failedFixture();
  await f.processor.run(f.incident.id);
  const [slot] = await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id));
  const publication = new RotationPublicationService({ db: f.d } as never, f.runtime as never);
  await expect(publication.publishSlot(f.slot.id)).rejects.toThrow("fresh_external_success_required");
  await f.d.update(db.addressHealthStates).set({ addressId: slot!.candidateAddressId, addressVersion: slot!.candidateVersion, latestDecision: "success", healthState: "healthy", consecutiveSuccesses: 3, lastCheckedAt: new Date(), evidenceExpiresAt: new Date(Date.now() + 60000) }).where(eq(db.addressHealthStates.slotId, f.slot.id));
  const next = await publication.publishSlot(f.slot.id);
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]!.resetRecoveryRetries).toBe(1);
  // These fixture Pools have no domain bindings; completed no-op decisions
  // constitute their entire publication, without pretending DNS writes occurred.
  for (const child of next!.children) await f.d.update(db.reconcileIntents).set({ completedAt: new Date() }).where(eq(db.reconcileIntents.eventId, child.eventId));
  await publication.observe(next!.id);
  expect((await f.d.select().from(db.rotationPublications).where(eq(db.rotationPublications.id, next!.id)))[0]!.status).toBe("applied");
  expect((await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.id, f.slot.id)))[0]!.resetRecoveryRetries).toBe(0);
});

it.each(["manual", "scheduled"])("leaves nonautomatic %s failures to their existing recovery path", async trigger => {
  const f = await failedFixture();
  await f.d.update(db.rotationPolicies).set({ enabled: false }).where(eq(db.rotationPolicies.slotId, f.slot.id));
  await f.d.update(db.rotationIncidents).set({ trigger: trigger as "manual" | "scheduled", ...(trigger === "manual" ? { healthPolicyId: null, healthPolicyRevision: null, configId: null, configRevision: null, groupId: null, groupRevision: null } : {}) }).where(eq(db.rotationIncidents.id, f.incident.id));
  expect(await new RotationResetRecoveryService({ db: f.d } as never, f.runtime as never).recover(f.incident.id)).toBe(false);
  expect(f.state.inspections).toBe(0);
});

it("supersedes a queued sibling health incident so both address families do not deadlock behind the failed physical owner", async () => {
  const f = await failedFixture();
  const [slot] = await f.d.insert(db.managedAddressSlots).values({ interfaceId: f.slot.interfaceId, family: "6", name: "v6" }).returning();
  const [sibling] = await f.d.insert(db.rotationIncidents).values({ ownerUserId: f.account.ownerUserId, slotId: slot!.id, family: "6", trigger: "health", physicalKey: f.incident.physicalKey,
    sourceEventId: randomUUID(), currentSegmentId: randomUUID(), authorizationRevision: 1, policyRevision: 1, addressVersion: 1,
    healthPolicyId: f.policy.id, healthPolicyRevision: 1, configId: f.policy.configId, configRevision: 1, groupId: f.policy.groupId!, groupRevision: 1 }).returning();
  await f.d.insert(db.rotationLeases).values({ physicalKey: f.incident.physicalKey, incidentId: f.incident.id });
  await f.processor.run(f.incident.id);
  expect(f.state.inspections).toBe(1);
  for (const id of [f.incident.id, sibling!.id]) expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, id)))[0]).toMatchObject({ status: "complete", errorCode: "cloud_state_reset" });
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.incidentId).toBeNull();
});

it("resets an ambiguous cloud result while retaining its resources and observation history", async () => {
  const f = await failedFixture();
  const [attempt] = await f.d.insert(db.rotationAttempts).values({ id: randomUUID(), incidentId: f.incident.id, segmentId: f.incident.currentSegmentId, sequence: 1, beforeInventory: {} }).returning();
  const [step] = await f.d.insert(db.rotationSteps).values({ id: randomUUID(), attemptId: attempt!.id, sequence: 0, status: "pending", fence: 1,
    plan: { id: "old", action: "lightsail.static-ip.attach", resourceKey: "old", arguments: {}, destructive: true } }).returning();
  await f.d.update(db.rotationIncidents).set({ currentAttemptId: attempt!.id, errorCode: null }).where(eq(db.rotationIncidents.id, f.incident.id));
  await f.d.insert(db.rotationLeases).values({ physicalKey: f.incident.physicalKey, incidentId: f.incident.id, unresolvedStepId: step!.id });
  await f.store.saveReceipt(f.incident.id, step!.id, { status: "ambiguous" } as never, true, 1);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]!.errorCode).toBe("resource_ownership_ambiguous");
  await f.processor.run(f.incident.id);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ status: "complete", errorCode: "cloud_state_reset" });
  expect((await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, step!.id)))[0]!.status).toBe("abandoned");
  expect(await f.d.select().from(db.rotationStepObservations).where(eq(db.rotationStepObservations.stepId, step!.id))).toHaveLength(1);
});
