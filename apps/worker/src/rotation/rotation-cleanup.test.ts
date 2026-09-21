import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
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
it("retains original user addresses without independent release authorization", async () => {
  const f = await cleanupFixture("user");
  await f.cleanup.run(f.resource.id, new Date());
  expect(f.state.writes).toBe(0);
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

it("retains an IPv6 resource still referenced by an equivalent expanded DNS address", async () => {
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
  expect(f.state.writes).toBe(0);
  expect((await f.d.select().from(db.rotationResources).where(eq(db.rotationResources.id, f.resource.id)))[0]!.cleanupError).toBe(
    "cleanup_resource_referenced",
  );
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
it.each(admissionChanges.flatMap(change => (["4", "6"] as const).map(family => ({ change, family }))))(
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
