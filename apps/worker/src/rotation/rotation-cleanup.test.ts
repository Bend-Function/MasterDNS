import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { terminateRotationIncident } from "@masterdns/db";
import * as db from "@masterdns/db";
import { fixture } from "./rotation-test-utils.js";
import { RotationCleanupService } from "./rotation-cleanup.service.js";
async function cleanupFixture(origin: "system" | "user" = "system", family: "4" | "6" = "4", oldAddress?: string) {
  const f = await fixture(family);
  await f.service.recover();
  await f.d
    .update(db.rotationPublications)
    .set({ status: "applied", appliedAt: new Date() })
    .where(eq(db.rotationPublications.slotId, f.slot.id));
  await f.d.insert(db.rotationPolicies).values({ slotId: f.slot.id, enabled: true });
  await f.d.update(db.instanceAuthorizations).set({ allowIpv4Rotation: family === "4", allowIpv6Rotation: family === "6" })
    .where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  const segment = randomUUID(),
    attempt = randomUUID();
  const [incident] = await f.d
    .insert(db.rotationIncidents)
    .values({
      ownerUserId: f.account.ownerUserId,
      slotId: f.slot.id,
      family,
      physicalKey: JSON.stringify(["aws", f.account.externalAccountId, "ec2", "us-east-1", f.instance.externalId]),
      sourceEventId: randomUUID(),
      phase: "cleanup",
      currentSegmentId: segment,
      currentAttemptId: attempt,
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
  await f.d.insert(db.rotationBudgetSegments).values({ id: segment, incidentId: incident!.id, maxAttempts: 3 });
  const old = oldAddress ?? (family === "4" ? "192.0.2.1" : "2001:db8::1"),
    before = structuredClone(f.live);
  before.interfaces[0]!.addresses = [
    {
      address: old,
      family: Number(family),
      primary: family === "4",
      ...(family === "4" ? { allocationId: "eipalloc-old", privateAddress: "10.0.0.1" } : {}),
    } as never,
  ];
  await f.d
    .insert(db.rotationAttempts)
    .values({ id: attempt, incidentId: incident!.id, segmentId: segment, sequence: 1, beforeInventory: before });
  const [resource] = await f.d
    .insert(db.rotationResources)
    .values({
      incidentId: incident!.id,
      attemptId: attempt,
      address: old,
      allocationId: family === "4" ? "eipalloc-old" : null,
      origin,
      ownershipAttemptId: origin === "system" ? attempt : null,
      role: "original",
      snapshot: {
        slot: { ...before.ref, interfaceId: before.interfaces[0]!.id, slotId: f.slot.id, address: old, family: Number(family) },
        inventory: before,
        ownership: before.interfaces[0]!.addresses[0],
      },
      cleanupStatus: "pending",
      cleanupDueAt: new Date(Date.now() - 1000),
      cleanupAddressVersion: 1,
    })
    .returning();
  const state = { writes: 0, observations: 0, observationStatus: "applied" as "applied" | "pending", lost: false, error: undefined as Error | undefined, attachedElsewhere: false, beforeInspect: undefined as (() => Promise<void>) | undefined };
  const adapter = {
    inspect: async () => { await state.beforeInspect?.(); return f.live; },
    execute: async () => {
      state.writes++;
      if (state.error) throw state.error;
      if (state.attachedElsewhere) throw new Error("resource_ownership_ambiguous");
      if (state.lost) throw new Error("transport_lost");
      return { allocationId: "eipalloc-old" };
    },
    observeDetails: async () => {
      state.observations++;
      return { status: state.observationStatus, allocationId: "eipalloc-old" };
    },
  };
  const cleanup = new RotationCleanupService({ db: f.d } as never, { adapter: async () => adapter } as never);
  return { ...f, resource: resource!, state, cleanup, incident: incident! };
}

let linodeCleanupAddress = 100;
async function linodeSwapCleanupFixture() {
  const f = await cleanupFixture("user", "4", `203.0.113.${++linodeCleanupAddress}`);
  const externalAccountId = randomUUID();
  const physicalKey = JSON.stringify(["linode", externalAccountId, "linode", "us-east", "42"]);
  const helperKey = JSON.stringify(["linode", externalAccountId, "linode", "us-east", "99"]);
  await f.d.update(db.cloudAccounts).set({ provider: "linode", externalAccountId }).where(eq(db.cloudAccounts.id, f.account.id));
  await f.d.update(db.cloudInstances).set({ service: "linode", region: "us-east", externalId: "42" }).where(eq(db.cloudInstances.id, f.instance.id));
  await f.d.update(db.cloudInterfaces).set({ externalId: "public" }).where(eq(db.cloudInterfaces.id, f.slot.interfaceId));
  await f.d.insert(db.cloudScanScopes).values({ accountId: f.account.id, service: "linode", region: "us-east", generation: 1 });
  await f.d.update(db.instanceAuthorizations).set({ allowStopStart: true }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  await f.d.update(db.rotationPolicies).set({ enabled: false, linodeIpv4Strategy: "instance_swap", linodeSwapPlan: "g6-nanode-1", linodeAllowTemporaryInstance: true }).where(eq(db.rotationPolicies.slotId, f.slot.id));
  await f.d.update(db.rotationIncidents).set({ physicalKey, trigger: "manual", releaseOldAddress: true, healthPolicyId: null, healthPolicyRevision: null, configId: null, configRevision: null, groupId: null, groupRevision: null }).where(eq(db.rotationIncidents.id, f.incident.id));
  await f.d.update(db.rotationPublications).set({ incidentId: f.incident.id }).where(eq(db.rotationPublications.slotId, f.slot.id));
  await f.d.delete(db.addressHealthStates).where(eq(db.addressHealthStates.slotId, f.slot.id));
  await f.d.delete(db.addressHealthPolicies).where(eq(db.addressHealthPolicies.slotId, f.slot.id));
  await f.d.delete(db.healthCheckConfigs).where(eq(db.healthCheckConfigs.id, f.policy.configId));
  const live: CloudInventory = f.live;
  live.ref = { accountId: f.account.id, service: "linode", region: "us-east", instanceId: "42" };
  live.interfaces[0]!.id = "public";
  live.interfaces[0]!.addresses = [{ address: f.address.address, family: 4, primary: true, allocationId: f.address.address, resourceId: `/linode/instances/42/ips/${f.address.address}` }];
  live.metadata = { interfaceGeneration: "legacy_config", configCount: 1, configId: 7, networkHelper: true, runLevel: "default", simplePublicInterface: true, advancedNetworking: false, eventWatermark: 10, externalAccountId, authenticatedUsername: "test", permissionScopes: ["*"], instanceCreated: "2025-01-01T00:00:00Z", reservedIpv4Count: 0 };
  const before = structuredClone(live);
  before.interfaces[0]!.addresses = [{ address: f.resource.address, family: 4, primary: true, allocationId: f.resource.address, resourceId: `/linode/instances/42/ips/${f.resource.address}` }];
  const temporaryInstance = { id: "99", label: `masterdns-swap-${createHash("sha256").update(JSON.stringify([f.account.id, "42", f.resource.attemptId])).digest("hex").slice(0, 32)}`, created: "2026-10-04T00:00:00Z", region: "us-east", attemptId: f.resource.attemptId, targetInstanceId: "42", originalAddress: f.resource.address, candidateAddress: f.address.address, type: "g6-nanode-1", accountId: f.account.id, externalAccountId };
  const receipt = { candidateAddress: f.address.address, allocationId: f.address.address, resourceId: `/linode/instances/42/ips/${f.address.address}`, after: { externalAccountId, instanceId: "42", region: "us-east", configId: 7, instanceCreated: "2025-01-01T00:00:00Z", attemptId: f.resource.attemptId, swapVerified: true, temporaryInstance } };
  const slot = { ...before.ref, interfaceId: "public", slotId: f.slot.id, address: f.resource.address, family: 4 };
  const snapshot = { slot, inventory: before, ownership: before.interfaces[0]!.addresses[0], linodeSwapReceipt: receipt };
  await f.d.update(db.rotationAttempts).set({ beforeInventory: before }).where(eq(db.rotationAttempts.id, f.resource.attemptId));
  await f.d.update(db.rotationResources).set({ snapshot, allocationId: f.resource.address, resourceId: `/linode/instances/42/ips/${f.resource.address}`, attached: false }).where(eq(db.rotationResources.id, f.resource.id));
  await f.d.insert(db.rotationLeases).values({ physicalKey: helperKey, incidentId: f.incident.id });
  const swap = { writes: [] as Array<Parameters<import("@masterdns/cloud-providers").CloudAdapter["execute"]>[0]>, observations: 0, lost: false, pending: false };
  const deleteReceipt = { ...receipt, allocationId: f.resource.address, resourceId: `/linode/instances/42/ips/${f.resource.address}` };
  const adapter = {
    inspect: async () => f.live,
    execute: async (step: Parameters<import("@masterdns/cloud-providers").CloudAdapter["execute"]>[0]) => {
      swap.writes.push(step);
      if (swap.lost) throw new CloudError("temporary_cloud_error", true);
      return deleteReceipt;
    },
    observeDetails: async () => { swap.observations++; return { ...deleteReceipt, status: swap.pending ? "pending" : "applied" }; },
  };
  const cleanup = new RotationCleanupService({ db: f.d } as never, { adapter: async () => adapter } as never);
  return { ...f, cleanup, swap, receipt, snapshot, before, helperKey, physicalKey, adapter };
}

it("deletes the saved temporary Linode only after DNS publication and TTL grace, then releases its reservation after readback", async () => {
  const f = await linodeSwapCleanupFixture();
  await f.d.update(db.rotationPublications).set({ status: "pending", appliedAt: null }).where(eq(db.rotationPublications.slotId, f.slot.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.swap.writes).toEqual([]);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({ cleanupError: "cleanup_publication_pending" });
  await f.d.update(db.rotationPublications).set({ status: "applied", appliedAt: new Date() }).where(eq(db.rotationPublications.slotId, f.slot.id));
  await f.d.update(db.rotationResources).set({ cleanupDueAt: new Date(Date.now() + 60000) }).where(eq(db.rotationResources.id, f.resource.id));
  await f.cleanup.run(f.resource.id, new Date(Date.now() + 120000));
  expect(f.swap.writes).toEqual([]);
  await f.d.update(db.rotationResources).set({ cleanupDueAt: new Date(0) }).where(eq(db.rotationResources.id, f.resource.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.swap.writes).toMatchObject([{ action: "linode.swap.delete", arguments: { linodeSwapReceipt: { after: { temporaryInstance: { id: "99", targetInstanceId: "42" } } }, publishedAddress: f.address.address, allowTemporaryInstance: true } }]);
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.helperKey)))[0]).toMatchObject({ incidentId: f.incident.id, unresolvedStepId: f.swap.writes[0]!.id });
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]!.cleanupStatus).toBe("pending");
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.swap.writes).toHaveLength(1);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]!.cleanupStatus).toBe("released");
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.helperKey)))[0]).toMatchObject({ incidentId: null, unresolvedStepId: null });
  await f.cleanup.complete(f.incident.id);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ status: "complete" });
});

it("removes confirmed deleted Linode helper inventory while retaining the production machine and audit steps", async () => {
  const f = await linodeSwapCleanupFixture();
  const proof = f.receipt.after.temporaryInstance;
  const [helper] = await f.d.insert(db.cloudInstances).values({ accountId: f.account.id, service: "linode", region: proof.region, externalId: proof.id, name: proof.label, scanGeneration: 1, metadata: { present: true, providerMetadata: { instanceCreated: proof.created } } }).returning();
  const [iface] = await f.d.insert(db.cloudInterfaces).values({ instanceId: helper!.id, externalId: "public", scanGeneration: 1 }).returning();
  const [address] = await f.d.insert(db.cloudAddresses).values({ interfaceId: iface!.id, kind: "host", family: "4", address: proof.originalAddress, origin: "user", scanGeneration: 1 }).returning();
  await f.d.insert(db.managedAddressSlots).values({ interfaceId: iface!.id, family: "4", name: "primary", currentAddressId: address!.id });
  await f.cleanup.run(f.resource.id, new Date());
  expect(await f.d.select().from(db.cloudInstances).where(eq(db.cloudInstances.id, helper!.id))).toHaveLength(1);
  await f.cleanup.run(f.resource.id, new Date());
  expect(await f.d.select().from(db.cloudInstances).where(eq(db.cloudInstances.id, helper!.id))).toHaveLength(0);
  expect(await f.d.select().from(db.cloudInterfaces).where(eq(db.cloudInterfaces.id, iface!.id))).toHaveLength(0);
  expect(await f.d.select().from(db.cloudAddresses).where(eq(db.cloudAddresses.id, address!.id))).toHaveLength(0);
  expect(await f.d.select().from(db.managedAddressSlots).where(eq(db.managedAddressSlots.interfaceId, iface!.id))).toHaveLength(0);
  expect(await f.d.select().from(db.cloudInstances).where(eq(db.cloudInstances.id, f.instance.id))).toHaveLength(1);
  expect((await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, f.swap.writes[0]!.id)))[0]!.status).toBe("applied");
});

it("retains the temporary Linode when cleanup authorization is revoked", async () => {
  const f = await linodeSwapCleanupFixture();
  await f.d.update(db.rotationPolicies).set({ linodeAllowTemporaryInstance: false }).where(eq(db.rotationPolicies.slotId, f.slot.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.swap.writes).toEqual([]);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]!.cleanupStatus).toBe("failed");
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.helperKey)))[0]!.incidentId).toBe(f.incident.id);
});

it("observes a lost temporary Linode delete response after grant revocation without deleting twice", async () => {
  const f = await linodeSwapCleanupFixture();
  f.swap.lost = true;
  await f.cleanup.run(f.resource.id, new Date());
  await f.d.update(db.rotationPolicies).set({ linodeAllowTemporaryInstance: false }).where(eq(db.rotationPolicies.slotId, f.slot.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.swap.writes).toHaveLength(1);
  expect(f.swap.observations).toBe(1);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]!.cleanupStatus).toBe("released");
});

it("retains both temporary Linode delete fences after termination and late readback until operator resolution", async () => {
  const f = await linodeSwapCleanupFixture();
  await f.cleanup.run(f.resource.id, new Date());
  const stepId = f.swap.writes[0]!.id;
  await f.d.transaction(tx => terminateRotationIncident(tx, f.incident.id, f.account.ownerUserId));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.swap.writes).toHaveLength(1);
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.helperKey)))[0]).toMatchObject({ incidentId: f.incident.id, unresolvedStepId: stepId });
  const observed = await f.adapter.observeDetails();
  await (f.cleanup as any).receipt(f.resource, stepId, observed, true);
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.helperKey)))[0]).toMatchObject({ incidentId: f.incident.id, unresolvedStepId: stepId });
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.physicalKey)))[0]).toMatchObject({ incidentId: f.incident.id, unresolvedStepId: stepId });
  const [helper] = await f.d.insert(db.cloudInstances).values({ accountId: f.account.id, service: "linode", region: "us-east", externalId: "99", metadata: { present: true }, scanGeneration: 1 }).returning();
  await f.d.insert(db.instanceAuthorizations).values({ instanceId: helper!.id, managed: true, allowStopStart: true, allowDelete: true });
  expect(await f.d.transaction(async tx => db.lifecycleAuthorizationError(await db.lockCloudLifecycleContext(tx, helper!.id), "delete"))).toBe("rotation_in_progress");
  expect((await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, stepId)))[0]).toMatchObject({ receipt: { after: { temporaryInstance: { id: "99" } } } });
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]!.cleanupStatus).toBe("retained");
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ status: "complete", errorCode: "manual_terminated" });
});

it("cleans a previous candidate through the later original swap receipt so a second attempt selects its own helper", async () => {
  const f = await linodeSwapCleanupFixture();
  const earlierAttemptId = randomUUID();
  await f.d.update(db.rotationAttempts).set({ sequence: 2 }).where(eq(db.rotationAttempts.id, f.resource.attemptId));
  await f.d.insert(db.rotationAttempts).values({ id: earlierAttemptId, incidentId: f.incident.id, segmentId: f.incident.currentSegmentId, sequence: 1, beforeInventory: f.before });
  const earlierHelper = { ...f.receipt.after.temporaryInstance, id: "98", attemptId: earlierAttemptId, originalAddress: "203.0.113.1", candidateAddress: f.resource.address,
    label: `masterdns-swap-${createHash("sha256").update(JSON.stringify([f.account.id, "42", earlierAttemptId])).digest("hex").slice(0, 32)}` };
  const [alias] = await f.d.insert(db.rotationResources).values({ incidentId: f.incident.id, attemptId: earlierAttemptId, address: f.resource.address, allocationId: f.resource.address, resourceId: `/linode/instances/42/ips/${f.resource.address}`, origin: "system", ownershipAttemptId: earlierAttemptId, role: "candidate", attached: false, cleanupStatus: "pending", cleanupDueAt: new Date(0), cleanupAddressVersion: 1,
    createdAt: new Date(Date.now() - 60000), snapshot: { slot: f.snapshot.slot, receipt: { candidateAddress: f.resource.address, allocationId: f.resource.address, resourceId: `/linode/instances/42/ips/${f.resource.address}`, after: { ...f.receipt.after, attemptId: earlierAttemptId, temporaryInstance: earlierHelper } } } }).returning();
  await f.d.update(db.rotationResources).set({ origin: "system", ownershipAttemptId: earlierAttemptId }).where(eq(db.rotationResources.id, f.resource.id));
  await f.cleanup.run(alias!.id, new Date());
  expect(f.swap.writes).toEqual([]);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, alias!.id)))[0]!.snapshot.cleanupCanonicalResourceId).toBe(f.resource.id);
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.swap.writes).toMatchObject([{ action: "linode.swap.delete", arguments: { linodeSwapReceipt: { after: { temporaryInstance: { id: "99" } } } } }]);
  await f.cleanup.run(f.resource.id, new Date());
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, alias!.id)))[0]!.cleanupStatus).toBe("released");
  expect(f.swap.writes).toHaveLength(1);
});

it("retains original user addresses without independent release authorization", async () => {
  const f = await cleanupFixture("user");
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(0);
});
it("waits quietly for a lifecycle hold while retaining observation of a dispatched cleanup", async () => {
  const f = await cleanupFixture();
  await f.d.insert(db.cloudInstanceControls).values({ physicalKey: f.incident.physicalKey, powerHold: "manual_stop" });
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(0);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({ cleanupStatus: "pending", cleanupError: "instance_lifecycle_busy" });
  await f.d.update(db.cloudInstanceControls).set({ powerHold: null }).where(eq(db.cloudInstanceControls.physicalKey, f.incident.physicalKey));
  await f.d.update(db.rotationResources).set({ cleanupDueAt: new Date(0) }).where(eq(db.rotationResources.id, f.resource.id));
  f.state.lost = true;
  await f.cleanup.run(f.resource.id, new Date());
  await f.d.update(db.cloudInstanceControls).set({ powerHold: "manual_stop" }).where(eq(db.cloudInstanceControls.physicalKey, f.incident.physicalKey));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
  expect(f.state.observations).toBe(1);
});
it("new rotations release replaced user IPs after takeover without a separate legacy grant", async () => {
  const f = await cleanupFixture("user");
  await f.d.update(db.rotationIncidents).set({ releaseOldAddress: true }).where(eq(db.rotationIncidents.id, f.incident.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
  expect(await f.d.transaction(tx => db.idleIpAddressReleasing(tx, f.resource.address))).toBe(true);
  await f.cleanup.run(f.resource.id, new Date());
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({ cleanupStatus: "released" });
  expect(await f.d.transaction(tx => db.idleIpAddressReleasing(tx, f.resource.address))).toBe(false);
});
it.each(["history", "observed", "linked", "active", "absent"] as const)("releases an old IP despite %s slot references", async kind => {
  const oldAddressValue = { history: "198.51.100.201", observed: "198.51.100.202", linked: "198.51.100.203", active: "198.51.100.204", absent: "198.51.100.205" }[kind];
  const f = await cleanupFixture("user", "4", oldAddressValue);
  await f.d.update(db.rotationIncidents).set({ releaseOldAddress: true }).where(eq(db.rotationIncidents.id, f.incident.id));
  const [oldAddress] = await f.d.insert(db.cloudAddresses).values({ interfaceId: f.slot.interfaceId, kind: "host", family: "4", address: f.resource.address, origin: "user", scanGeneration: 1 }).returning();
  const [duplicate] = await f.d.insert(db.managedAddressSlots).values({ interfaceId: f.slot.interfaceId, family: "4", name: "historical-copy", currentAddressId: oldAddress!.id, currentVersion: 1 }).returning();
  if (kind === "absent") await f.d.update(db.cloudAddresses).set({ inventoryPresent: false }).where(eq(db.cloudAddresses.id, oldAddress!.id));
  if (kind !== "observed" && kind !== "absent") {
    await f.d.update(db.cloudInstances).set({ scanGeneration: 2 }).where(eq(db.cloudInstances.id, f.instance.id));
    await f.d.update(db.cloudInterfaces).set({ scanGeneration: 2 }).where(eq(db.cloudInterfaces.id, f.slot.interfaceId));
    await f.d.update(db.cloudAddresses).set({ scanGeneration: 2 }).where(eq(db.cloudAddresses.id, f.address.id));
    await f.d.update(db.cloudScanScopes).set({ generation: 2 }).where(eq(db.cloudScanScopes.accountId, f.account.id));
  }
  if (kind === "linked") {
    await f.d.update(db.cloudEndpointLinks).set({ slotId: duplicate!.id }).where(eq(db.cloudEndpointLinks.endpointId, f.endpoints[0]!.id));
  }
  if (kind === "active") await f.d.insert(db.rotationIncidents).values({ ...f.incident, id: randomUUID(), slotId: duplicate!.id, sourceEventId: randomUUID(), currentAttemptId: null });
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
});
it("terminates stuck cleanup permanently, including stale jobs and late failure handlers", async () => {
  const f = await cleanupFixture();
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
  await f.d.transaction(tx => terminateRotationIncident(tx, f.incident.id, f.account.ownerUserId));
  await (f.cleanup as any).receipt(f.resource, `cleanup:${f.resource.id}`, { status: "applied", allocationId: "eipalloc-old" }, true);
  await f.cleanup.run(f.resource.id, new Date());
  await f.cleanup.complete(f.incident.id);
  expect(f.state.writes).toBe(1);
  expect(f.state.observations).toBe(0);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({ cleanupStatus: "retained", cleanupDueAt: null });
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ status: "complete", errorCode: "manual_terminated" });
});
it("does not resurrect cleanup when termination happens during cloud inspection", async () => {
  const f = await cleanupFixture();
  f.state.beforeInspect = async () => {
    await f.d.transaction(tx => terminateRotationIncident(tx, f.incident.id, f.account.ownerUserId));
    throw new Error("late_network_failure");
  };
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(0);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({ cleanupStatus: "retained", cleanupDueAt: null, cleanupError: "manual_terminated" });
});
it("defers cleanup without dispatch or unresolved effects when the shared budget is cooling down", async () => {
  const f = await cleanupFixture();
  const until = await f.d.transaction(tx => db.recordCloudRotationThrottle(tx, { accountId: f.account.id, service: "ec2", region: "us-east-1", stepId: `cleanup:${f.resource.id}`, action: "ec2.eip.release", retryAfterMs: 180000 }));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(0);
  const [resource] = await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id));
  expect(resource).toMatchObject({ cleanupStatus: "pending", cleanupError: "rotation_rate_limited" });
  expect(resource!.cleanupDueAt!.getTime()).toBeGreaterThanOrEqual(until.getTime());
  expect((await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, resource!.cleanupStepId!)))[0]!.status).toBe("prepared");
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.unresolvedStepId).toBeNull();
  await f.d.update(db.cloudRotationBuckets).set({ cooldownUntil: new Date(0) }).where(eq(db.cloudRotationBuckets.identityKey, JSON.stringify(["aws", f.account.externalAccountId, "ec2"])));
  await f.d.update(db.rotationResources).set({ cleanupDueAt: new Date(0) }).where(eq(db.rotationResources.id, f.resource.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
});
it("manual AWS cleanup needs no probes but still waits for TTL and preserves user release authorization", async () => {
  for (const origin of ["system", "user"] as const) {
    const f = await cleanupFixture(origin);
    await f.d.update(db.rotationIncidents).set({ trigger: "manual", healthPolicyId: null, healthPolicyRevision: null, configId: null, configRevision: null, groupId: null, groupRevision: null }).where(eq(db.rotationIncidents.id, f.incident.id));
    await f.d.update(db.rotationPolicies).set({ enabled: false }).where(eq(db.rotationPolicies.slotId, f.slot.id));
    await f.d.delete(db.addressHealthStates).where(eq(db.addressHealthStates.slotId, f.slot.id));
    await f.d.delete(db.addressHealthPolicies).where(eq(db.addressHealthPolicies.slotId, f.slot.id));
    await f.d.delete(db.healthCheckConfigs).where(eq(db.healthCheckConfigs.id, f.policy.configId));
    await f.d.update(db.rotationResources).set({ cleanupDueAt: new Date(Date.now() + 60000) }).where(eq(db.rotationResources.id, f.resource.id));
    await f.cleanup.run(f.resource.id, new Date()); expect(f.state.writes).toBe(0);
    await f.d.update(db.rotationResources).set({ cleanupDueAt: new Date(0) }).where(eq(db.rotationResources.id, f.resource.id));
    await f.cleanup.run(f.resource.id, new Date());
    expect(f.state.writes).toBe(origin === "system" ? 1 : 0);
  }
});
it("does not clean before grace or while the old address is published, then observes a lost cleanup response without redispatch", async () => {
  const f = await cleanupFixture();
  await f.d
    .update(db.rotationResources)
    .set({ cleanupDueAt: new Date(Date.now() + 60000) })
    .where(eq(db.rotationResources.id, f.resource.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(0);
  await f.d
    .update(db.rotationResources)
    .set({ cleanupDueAt: new Date(0) })
    .where(eq(db.rotationResources.id, f.resource.id));
  f.state.lost = true;
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
  const [step] = await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.attemptId, f.resource.attemptId));
  expect(step!.plan.arguments.phase).toBe("post_publish_cleanup");
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
  expect(f.state.observations).toBe(1);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]!.cleanupStatus).toBe(
    "released",
  );
});
it("retains the current or last attached candidate and a changed slot version", async () => {
  const f = await cleanupFixture();
  await f.d.update(db.rotationResources).set({ address: f.address.address }).where(eq(db.rotationResources.id, f.resource.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(0);
  await f.d
    .update(db.rotationResources)
    .set({ address: "192.0.2.1", cleanupAddressVersion: 99 })
    .where(eq(db.rotationResources.id, f.resource.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(0);
});

import { CloudError, Ec2CloudAdapter, type CloudInventory } from "@masterdns/cloud-providers";
it("uses real EC2 cleanup preconditions to preserve an EIP reassociated to a foreign ENI", async () => {
  const f = await cleanupFixture();
  const writes: string[] = [];
  const adapter = new Ec2CloudAdapter(
    f.account.id,
    { kind: "access_key", accessKeyId: "fake", secretAccessKey: "fake" },
    {
      ec2Send: async (c: any) => {
        if (c.constructor.name === "DescribeNetworkInterfacesCommand")
          return {
            NetworkInterfaces: [
              {
                NetworkInterfaceId: f.live.interfaces[0]!.id,
                Attachment: { InstanceId: f.instance.externalId, DeviceIndex: 0 },
                PrivateIpAddresses: [{ Primary: true, PrivateIpAddress: "10.0.0.1", Association: { PublicIp: f.address.address } }],
              },
            ],
          };
        if (c.constructor.name === "DescribeAddressesCommand")
          return {
            Addresses: [
              {
                AllocationId: f.resource.allocationId,
                PublicIp: f.resource.address,
                AssociationId: "association-foreign",
                NetworkInterfaceId: "eni-foreign",
              },
            ],
          };
        writes.push(c.constructor.name);
        return {};
      },
    },
  );
  const cleanup = new RotationCleanupService(
    { db: f.d } as never,
    {
      adapter: async () => ({
        inspect: async () => f.live,
        execute: adapter.execute.bind(adapter),
        observeDetails: adapter.observeDetails.bind(adapter),
      }),
    } as never,
  );
  await cleanup.run(f.resource.id, new Date());
  expect(writes).toEqual([]);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]!.cleanupError).toBe(
    "resource_ownership_ambiguous",
  );
});
it("unassigns only the old non-primary IPv6 from the original ENI while the replacement remains assigned", async () => {
  const f = await cleanupFixture("system", "6");
  const writes: any[] = [];
  let oldPresent = true;
  f.live.interfaces[0]!.addresses.push({ address: f.resource.address, family: 6, primary: false });
  const adapter = new Ec2CloudAdapter(
    f.account.id,
    { kind: "access_key", accessKeyId: "fake", secretAccessKey: "fake" },
    {
      ec2Send: async (c: any) => {
        if (c.constructor.name === "DescribeNetworkInterfacesCommand")
          return {
            NetworkInterfaces: [
              {
                NetworkInterfaceId: f.live.interfaces[0]!.id,
                Attachment: { InstanceId: f.instance.externalId, DeviceIndex: 0 },
                Ipv6Addresses: [
                  { Ipv6Address: f.address.address, IsPrimaryIpv6: false },
                  ...(oldPresent ? [{ Ipv6Address: f.resource.address, IsPrimaryIpv6: false }] : []),
                ],
              },
            ],
          };
        writes.push(c);
        oldPresent = false;
        return {};
      },
    },
  );
  const cleanup = new RotationCleanupService(
    { db: f.d } as never,
    {
      adapter: async () => ({
        inspect: async () => f.live,
        execute: adapter.execute.bind(adapter),
        observeDetails: adapter.observeDetails.bind(adapter),
      }),
    } as never,
  );
  await cleanup.run(f.resource.id, new Date());
  await cleanup.run(f.resource.id, new Date());
  expect(writes.map((c) => [c.constructor.name, c.input])).toEqual([
    ["UnassignIpv6AddressesCommand", { NetworkInterfaceId: f.live.interfaces[0]!.id, Ipv6Addresses: [f.resource.address] }],
  ]);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]!.cleanupStatus).toBe(
    "released",
  );
});

it("releases an IPv6 resource despite an equivalent expanded DNS address", async () => {
  const f = await cleanupFixture("system", "6");
  const [account] = await f.d
    .insert(db.providerAccounts)
    .values({
      ownerUserId: f.account.ownerUserId,
      name: "dns",
      provider: "cloudflare",
      credentialCiphertext: "test",
      credentialIv: "iv",
      credentialTag: "tag",
    })
    .returning();
  const [zone] = await f.d
    .insert(db.zones)
    .values({ providerAccountId: account!.id, externalId: randomUUID(), nameAscii: "reference.test" })
    .returning();
  await f.d.insert(db.dnsRecords).values({
    zoneId: zone!.id,
    externalId: "old-v6",
    type: "AAAA",
    name: "www.reference.test",
    content: "2001:0DB8:0000:0000:0000:0000:0000:0001",
    ttl: 60,
    remoteHash: "test",
  });
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
});
it("uses the immutable original ownership snapshot only after independent release opt-in", async () => {
  const f = await cleanupFixture("user");
  await f.d
    .update(db.instanceAuthorizations)
    .set({ allowReleaseAddress: true })
    .where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
  const [resource] = await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id));
  const [step] = await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, resource!.cleanupStepId!));
  expect(step!.plan.arguments.ownershipSnapshot).toMatchObject({
    accountId: f.account.id,
    instanceId: f.instance.externalId,
    allocationId: f.resource.allocationId,
    address: f.resource.address,
  });
});

it("persists cleanup failure markers for the durable notification scanner", async () => {
  const f = await cleanupFixture();
  f.state.lost = true;
  await f.cleanup.run(f.resource.id, new Date());
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({
    cleanupStatus: "failed",
    cleanupError: "transport_lost",
  });
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({
    phase: "cleanup",
    errorCode: "cleanup_failed",
  });
  await f.cleanup.run(f.resource.id, new Date());
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]!.errorCode).toBeNull();
});

const admissionChanges = ["pause", "authorization", "rotation policy", "health policy", "health config", "probe group", "address version"] as const;
async function changeAdmission(f: Awaited<ReturnType<typeof cleanupFixture>>, change: typeof admissionChanges[number]) {
  await f.d.transaction(async tx => {
    await db.lockRotationContext(tx, f.slot.id);
    if (change === "pause") await tx.update(db.rotationIncidents).set({ status: "paused", pausedByUserId: f.account.ownerUserId }).where(eq(db.rotationIncidents.id, f.incident.id));
    if (change === "authorization") await tx.update(db.instanceAuthorizations).set({ revision: 2 }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
    if (change === "rotation policy") await tx.update(db.rotationPolicies).set({ revision: 2 }).where(eq(db.rotationPolicies.slotId, f.slot.id));
    if (change === "health policy") await tx.update(db.addressHealthPolicies).set({ revision: 2 }).where(eq(db.addressHealthPolicies.id, f.policy.id));
    if (change === "health config") await tx.update(db.healthCheckConfigs).set({ revision: 2 }).where(eq(db.healthCheckConfigs.id, f.policy.configId));
    if (change === "probe group") await tx.update(db.probeGroups).set({ revision: 2 }).where(eq(db.probeGroups.id, f.policy.groupId!));
    if (change === "address version") await tx.update(db.rotationIncidents).set({ addressVersion: 2 }).where(eq(db.rotationIncidents.id, f.incident.id));
  });
}
it.each(["authorization", "rotation policy", "health policy", "health config", "probe group"] as const)(
  "releases a published old IP after %s revision changes", async change => {
    const f = await cleanupFixture("user");
    await f.d.update(db.rotationIncidents).set({ releaseOldAddress: true }).where(eq(db.rotationIncidents.id, f.incident.id));
    await changeAdmission(f, change);
    await f.cleanup.run(f.resource.id, new Date());
    expect(f.state.writes).toBe(1);
    expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({ cleanupStatus: "pending", cleanupError: null });
  },
);
it("releases a published old IP after the slot advances to a newer address version", async () => {
  const f = await cleanupFixture("user");
  await f.d.update(db.rotationIncidents).set({ releaseOldAddress: true }).where(eq(db.rotationIncidents.id, f.incident.id));
  await f.d.update(db.managedAddressSlots).set({ currentVersion: 2 }).where(eq(db.managedAddressSlots.id, f.slot.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
});
it("releases a replaced Lightsail static IP after the health policy revision changes", async () => {
  const f = await cleanupFixture("user");
  const instanceId = `arn:aws:lightsail:us-east-1:123456789012:Instance/${randomUUID()}`;
  const resourceId = "arn:aws:lightsail:us-east-1:123456789012:StaticIp/old-static";
  const physicalKey = JSON.stringify(["aws", f.account.externalAccountId, "lightsail", "us-east-1", instanceId]);
  const inventory = structuredClone(f.resource.snapshot.inventory) as typeof f.live;
  Object.assign(inventory.ref, { service: "lightsail", instanceId });
  Object.assign(inventory, { nativeName: "instance", ipv6Only: false });
  Object.assign(inventory.interfaces[0]!.addresses[0]!, { allocationId: "old-static", resourceId });
  Object.assign(f.live.ref, { service: "lightsail", instanceId });
  Object.assign(f.live, { nativeName: "instance", ipv6Only: false });
  await f.d.insert(db.cloudScanScopes).values({ accountId: f.account.id, service: "lightsail", region: "us-east-1", generation: 1 });
  await f.d.update(db.cloudInstances).set({ service: "lightsail", externalId: instanceId }).where(eq(db.cloudInstances.id, f.instance.id));
  await f.d.update(db.rotationIncidents).set({ physicalKey, releaseOldAddress: true }).where(eq(db.rotationIncidents.id, f.incident.id));
  await f.d.update(db.rotationAttempts).set({ beforeInventory: inventory }).where(eq(db.rotationAttempts.id, f.resource.attemptId));
  await f.d.update(db.rotationResources).set({ allocationId: "old-static", resourceId,
    snapshot: { ...f.resource.snapshot, slot: { ...(f.resource.snapshot.slot as object), service: "lightsail", instanceId }, inventory, ownership: inventory.interfaces[0]!.addresses[0] },
  }).where(eq(db.rotationResources.id, f.resource.id));
  await f.d.update(db.addressHealthPolicies).set({ revision: 2 }).where(eq(db.addressHealthPolicies.id, f.policy.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
  const [step] = await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.attemptId, f.resource.attemptId));
  expect(step!.plan.action).toBe("lightsail.static-ip.release");
});
it.each((["pause", "address version"] as const).flatMap(change => (["4", "6"] as const).map(family => ({ change, family }))))(
  "blocks new IPv$family cleanup when $change changes during cloud inspection", async ({ change, family }) => {
    const f = await cleanupFixture("system", family, family === "6" ? `2001:db8:${randomUUID().slice(0, 4)}::1` : undefined);
    f.state.beforeInspect = () => changeAdmission(f, change);
    await f.cleanup.run(f.resource.id, new Date());
    expect(f.state.writes).toBe(0);
    expect(await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.attemptId, f.resource.attemptId))).toEqual([]);
    expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]!.cleanupStepId).toBeNull();
    expect(await f.d.select().from(db.rotationBudgetSegments).where(eq(db.rotationBudgetSegments.incidentId, f.incident.id))).toMatchObject([{ id: f.incident.currentSegmentId, attemptsUsed: 0 }]);
  },
);
it.each((["authorization", "rotation policy", "health policy", "health config", "probe group"] as const).flatMap(change => (["4", "6"] as const).map(family => ({ change, family }))))(
  "allows published IPv$family cleanup when $change changes during cloud inspection", async ({ change, family }) => {
    const f = await cleanupFixture("system", family, family === "6" ? `2001:db8:${randomUUID().slice(0, 4)}::1` : undefined);
    f.state.beforeInspect = () => changeAdmission(f, change);
    await f.cleanup.run(f.resource.id, new Date());
    expect(f.state.writes).toBe(1);
  },
);
it("resumes cleanup against the original attempt and ownership snapshot", async () => {
  const f = await cleanupFixture("user");
  await f.d.update(db.instanceAuthorizations).set({ allowReleaseAddress: true, revision: 2 }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  await changeAdmission(f, "pause");
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(0);
  await f.d.transaction(async tx => db.resumeRotationIncident(tx, await db.lockRotationContext(tx, f.slot.id), f.incident.id, f.account.ownerUserId));
  await f.d.update(db.rotationResources).set({ cleanupDueAt: new Date(0) }).where(eq(db.rotationResources.id, f.resource.id));
  await f.cleanup.run(f.resource.id, new Date());
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
  const [resource] = await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id));
  expect(resource).toMatchObject({ attemptId: f.resource.attemptId, snapshot: f.resource.snapshot, cleanupStatus: "released" });
  expect((await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, resource!.cleanupStepId!)))[0]!.plan.arguments.ownershipSnapshot).toMatchObject({ address: f.resource.address, allocationId: f.resource.allocationId });
});
it.each(["pause", "revoke", "config"] as const)("observes an uncertain cleanup after %s without another cloud write", async change => {
  const f = await cleanupFixture();
  f.state.lost = true;
  await f.cleanup.run(f.resource.id, new Date());
  const [before] = await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id));
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.unresolvedStepId).toBe(before!.cleanupStepId);
  if (change === "pause") await changeAdmission(f, "pause");
  if (change === "revoke") await f.d.update(db.instanceAuthorizations).set({ managed: false, revision: 2 }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  if (change === "config") await changeAdmission(f, "health config");
  f.state.observationStatus = "pending";
  await f.cleanup.run(f.resource.id, new Date());
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.unresolvedStepId).toBe(before!.cleanupStepId);
  f.state.observationStatus = "applied";
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
  expect(f.state.observations).toBe(2);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({ cleanupStatus: "released", cleanupStepId: before!.cleanupStepId });
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.unresolvedStepId).toBeNull();
  expect(await f.d.select().from(db.rotationBudgetSegments).where(eq(db.rotationBudgetSegments.incidentId, f.incident.id))).toMatchObject([{ id: f.incident.currentSegmentId, attemptsUsed: 0 }]);
});

async function chainFixture() {
  const f = await cleanupFixture();
  await f.d.update(db.instanceAuthorizations).set({ allowStopStart: true }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  // This fixture tests the durable two-step orchestrator with a fake provider.
  // Its service must agree with the Linode reboot action now checked at admission.
  const first = await f.d.transaction(async tx => (f.cleanup as any).plan(tx, await db.lockRotationContext(tx, f.slot.id), f.resource, f.live));
  const release = first[0];
  const externalAccountId = randomUUID();
  await f.d.update(db.cloudAccounts).set({ provider: "linode", externalAccountId }).where(eq(db.cloudAccounts.id, f.account.id));
  await f.d.update(db.cloudInstances).set({ service: "linode", region: "us-east" }).where(eq(db.cloudInstances.id, f.instance.id));
  await f.d.insert(db.cloudScanScopes).values({ accountId: f.account.id, service: "linode", region: "us-east", generation: 1 });
  const physicalKey = JSON.stringify(["linode", externalAccountId, "linode", "us-east", f.instance.externalId]);
  await f.d.update(db.rotationIncidents).set({ physicalKey }).where(eq(db.rotationIncidents.id, f.incident.id));
  f.incident.physicalKey = physicalKey;
  f.account.provider = "linode"; f.account.externalAccountId = externalAccountId;
  const live: CloudInventory = f.live;
  live.ref.service = "linode"; live.ref.region = "us-east";
  release.arguments.slot.service = "linode"; release.arguments.slot.region = "us-east";
  release.arguments.before.ref.service = "linode"; release.arguments.before.ref.region = "us-east";
  (f.cleanup as any).plan = async () => [{ ...release, action: "linode.ipv4.release" }, { ...release, id: `${release.id}:reboot`, action: "linode.instance.reboot" }];
  return f;
}
it("persists the entire cleanup chain before DELETE, advances only on observation, and resumes the original reboot after pause", async () => {
  const f = await chainFixture();
  f.state.lost = true;
  await f.cleanup.run(f.resource.id, new Date());
  const steps = await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.attemptId, f.resource.attemptId));
  expect(steps).toHaveLength(2);
  expect(f.state.writes).toBe(1);
  const release = steps.find(s => s.plan.action !== "linode.instance.reboot")!;
  const reboot = steps.find(s => s.plan.action === "linode.instance.reboot")!;
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({ cleanupStatus: "pending", cleanupStepId: reboot.id });
  await changeAdmission(f, "pause");
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
  await f.d.transaction(async tx => db.resumeRotationIncident(tx, await db.lockRotationContext(tx, f.slot.id), f.incident.id, f.account.ownerUserId));
  await f.d.update(db.rotationResources).set({ cleanupDueAt: new Date(0) }).where(eq(db.rotationResources.id, f.resource.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(2);
  await (f.cleanup as any).receipt(f.resource, release.id, { status: "applied", allocationId: f.resource.allocationId }, true);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({ cleanupStepId: reboot.id, cleanupStatus: "failed" });
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.unresolvedStepId).toBe(reboot.id);
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(2);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({ cleanupStatus: "released", cleanupStepId: reboot.id });
});
it("rechecks current reboot permission after the release observation", async () => {
  const f = await chainFixture();
  await f.cleanup.run(f.resource.id, new Date());
  await f.cleanup.run(f.resource.id, new Date());
  await f.d.update(db.instanceAuthorizations).set({ allowStopStart: false }).where(eq(db.instanceAuthorizations.instanceId, f.instance.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]!.cleanupStatus).not.toBe("released");
});
it("completes manual Linode cleanup after observed release and reboot without probes", async () => {
  const f = await chainFixture();
  await f.d.update(db.rotationIncidents).set({ trigger: "manual", healthPolicyId: null, healthPolicyRevision: null, configId: null, configRevision: null, groupId: null, groupRevision: null }).where(eq(db.rotationIncidents.id, f.incident.id));
  await f.d.update(db.rotationPublications).set({ incidentId: f.incident.id }).where(eq(db.rotationPublications.slotId, f.slot.id));
  await f.d.update(db.rotationPolicies).set({ enabled: false }).where(eq(db.rotationPolicies.slotId, f.slot.id));
  await f.d.delete(db.addressHealthStates).where(eq(db.addressHealthStates.slotId, f.slot.id));
  await f.d.delete(db.addressHealthPolicies).where(eq(db.addressHealthPolicies.slotId, f.slot.id));
  await f.d.delete(db.healthCheckConfigs).where(eq(db.healthCheckConfigs.id, f.policy.configId));
  for (let round = 0; round < 4; round++) await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(2);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({ cleanupStatus: "released" });
  await f.cleanup.complete(f.incident.id);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ status: "complete", errorCode: null });
});

import { ProbeHealthService } from "../probes/probe-health.service.js";
import { HealthResultService } from "../health/health-result.service.js";
it("requires newly qualified external health after cleanup reboot and supersedes queued pre-reboot successes", async () => {
  const f = await chainFixture();
  await f.d.update(db.rotationPublications).set({ incidentId: f.incident.id }).where(eq(db.rotationPublications.slotId, f.slot.id));
  const [probe] = await f.d.insert(db.probeAgents).values({ ownerUserId: f.account.ownerUserId, name: "external", capabilities: { ipv4: true, ipv6: false } }).returning();
  const health = new ProbeHealthService({ db: f.d } as never, new HealthResultService({ db: f.d } as never));
  async function round(sequence: number, outcome: "success" | "failure") {
    const now = new Date();
    const [r] = await f.d.insert(db.probeRounds).values({ slotId: f.slot.id, configId: f.policy.configId, groupId: f.policy.groupId, groupRevision: 1, policyId: f.policy.id, policyRevision: 1, sequence, addressVersion: 1, configVersion: 1, address: f.address.address, family: "4", config: { type: "tcp", port: 443, timeoutMs: 1000 }, memberIds: [probe!.id], consensus: { mode: "majority", minimumValid: 1 }, deadline: new Date(now.getTime() - 500), resultExpiresAt: new Date(now.getTime() + 60000) }).returning();
    const [task] = await f.d.insert(db.probeTasks).values({ roundId: r!.id, probeId: probe!.id, status: "accepted" }).returning();
    await f.d.insert(db.probeObservations).values({ taskId: task!.id, roundId: r!.id, probeId: probe!.id, leaseId: randomUUID(), addressVersion: 1, configVersion: 1, status: "accepted", outcome, latencyMs: 1, measuredAt: new Date(now.getTime() - 1000), receivedAt: new Date(now.getTime() - 1000) });
    await f.d.insert(db.probeRoundSequences).values({ slotId: f.slot.id, family: "4", lastSequence: sequence }).onConflictDoUpdate({ target: db.probeRoundSequences.slotId, targetWhere: sql`${db.probeRoundSequences.slotId} is not null`, set: { lastSequence: sequence } });
    return r!.id;
  }
  const stale = await round(10, "success");
  for (let n = 0; n < 4; n++) await f.cleanup.run(f.resource.id, new Date());
  const [resource] = await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id));
  expect(resource!.snapshot.cleanupHealthCutoff).toBe(10);
  await f.cleanup.complete(f.incident.id);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ phase: "cleanup", errorCode: "probe_insufficient" });
  expect(await health.closeRound(stale)).toBe("unknown");
  expect((await f.d.select().from(db.probeRounds).where(eq(db.probeRounds.id, stale)))[0]!.status).toBe("superseded");
  for (let n = 11; n <= 13; n++) await health.closeRound(await round(n, "failure"));
  await f.cleanup.complete(f.incident.id);
  expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ phase: "cleanup", errorCode: "cleanup_health_failed" });
  for (let n = 14; n <= 16; n++) {
    await health.closeRound(await round(n, "success"));
    await f.cleanup.complete(f.incident.id);
    expect((await f.d.select().from(db.rotationIncidents).where(eq(db.rotationIncidents.id, f.incident.id)))[0]!.status).toBe(n < 16 ? "active" : "complete");
  }
  expect(f.state.writes).toBe(2);
  expect(await f.d.select().from(db.rotationBudgetSegments).where(eq(db.rotationBudgetSegments.incidentId, f.incident.id))).toMatchObject([{ attemptsUsed: 0 }]);
});

it("treats a cleanup chain collision as ambiguous without dispatching its next write", async () => {
  const f = await chainFixture();
  await f.cleanup.run(f.resource.id, new Date());
  await f.cleanup.run(f.resource.id, new Date());
  const [resource] = await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id));
  await f.d.update(db.rotationSteps).set({ plan: { action: "linode.instance.reboot", id: resource!.cleanupStepId!, resourceKey: "foreign", destructive: true, arguments: { phase: "post_publish_cleanup", cleanupResourceId: randomUUID() } } }).where(eq(db.rotationSteps.id, resource!.cleanupStepId!));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({ cleanupStatus: "failed", cleanupError: "cleanup_plan_ambiguous", cleanupStepId: resource!.cleanupStepId });
});
it("retains legacy one-step cleanup IDs and receipts without rewriting the plan", async () => {
  const f = await cleanupFixture();
  f.state.lost = true;
  await f.cleanup.run(f.resource.id, new Date());
  const [resource] = await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id));
  const [step] = await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, resource!.cleanupStepId!));
  const { cleanupResourceId: _, ...arguments_ } = step!.plan.arguments;
  await f.d.update(db.rotationSteps).set({ plan: { ...step!.plan, arguments: arguments_ } }).where(eq(db.rotationSteps.id, step!.id));
  await f.d.update(db.rotationResources).set({ snapshot: f.resource.snapshot }).where(eq(db.rotationResources.id, f.resource.id));
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({ cleanupStatus: "released", cleanupStepId: step!.id, snapshot: f.resource.snapshot });
});

it("finishes a started resource chain before releasing another address on the same guest", async () => {
  const f = await chainFixture();
  await f.cleanup.run(f.resource.id, new Date());
  await f.cleanup.run(f.resource.id, new Date());
  const secondAttempt = randomUUID();
  const [attempt] = await f.d.select().from(db.rotationAttempts).where(eq(db.rotationAttempts.id, f.resource.attemptId));
  await f.d.insert(db.rotationAttempts).values({ ...attempt!, id: secondAttempt, sequence: 2 });
  const [second] = await f.d.insert(db.rotationResources).values({ ...f.resource, id: randomUUID(), attemptId: secondAttempt, address: "192.0.2.2" }).returning();
  await f.cleanup.run(second!.id, new Date());
  expect(f.state.writes).toBe(1);
  expect(await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.attemptId, secondAttempt))).toEqual([]);
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(2);
});

it("still records an admitted reboot observation after a contradictory late release receipt, without completing ambiguous cleanup", async () => {
  const f = await chainFixture();
  await f.cleanup.run(f.resource.id, new Date()); await f.cleanup.run(f.resource.id, new Date());
  const steps = await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.attemptId, f.resource.attemptId));
  const release = steps.find(step => step.plan.action !== "linode.instance.reboot")!;
  const reboot = steps.find(step => step.plan.action === "linode.instance.reboot")!;
  f.state.lost = true;
  await f.cleanup.run(f.resource.id, new Date());
  await (f.cleanup as any).receipt(f.resource, release.id, { status: "applied", allocationId: "foreign-allocation" }, true);
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(2);
  expect((await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, reboot.id)))[0]!.status).toBe("applied");
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]).toMatchObject({ cleanupStatus: "failed", cleanupStepId: reboot.id, cleanupError: "cleanup_ownership_ambiguous" });
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.unresolvedStepId).toBeNull();
});

it("persists a vendor cleanup cooldown without turning it into a failed cleanup", async () => {
  const f = await cleanupFixture();
  const before = Date.now();
  f.state.error = new CloudError("rate_limited", true, 180000);
  await f.cleanup.run(f.resource.id, new Date());
  const [resource] = await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id));
  expect(resource).toMatchObject({ cleanupStatus: "pending", cleanupError: "rotation_rate_limited" });
  expect(resource!.cleanupDueAt!.getTime()).toBeGreaterThanOrEqual(before + 180000);
  expect((await f.d.select().from(db.rotationSteps).where(eq(db.rotationSteps.id, resource!.cleanupStepId!)))[0]).toMatchObject({ status: "rejected_no_effect", errorCode: "rate_limited" });
  expect((await f.d.select().from(db.rotationLeases).where(eq(db.rotationLeases.physicalKey, f.incident.physicalKey)))[0]!.unresolvedStepId).toBeNull();
  f.state.error = undefined;
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(1);
});
