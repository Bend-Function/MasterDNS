import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import * as db from "@masterdns/db";
import { fixture } from "./rotation-test-utils.js";
import { RotationCleanupService } from "./rotation-cleanup.service.js";
async function cleanupFixture(origin: "system" | "user" = "system", family: "4" | "6" = "4") {
  const f = await fixture(family);
  await f.service.recover();
  await f.d
    .update(db.rotationPublications)
    .set({ status: "applied", appliedAt: new Date() })
    .where(eq(db.rotationPublications.slotId, f.slot.id));
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
  const old = family === "4" ? "192.0.2.1" : "2001:db8::1",
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
  const state = { writes: 0, observations: 0, lost: false, attachedElsewhere: false };
  const adapter = {
    inspect: async () => f.live,
    execute: async () => {
      state.writes++;
      if (state.attachedElsewhere) throw new Error("resource_ownership_ambiguous");
      if (state.lost) throw new Error("transport_lost");
      return { allocationId: "eipalloc-old" };
    },
    observeDetails: async () => {
      state.observations++;
      return { status: "applied" as const, allocationId: "eipalloc-old" };
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

import { Ec2CloudAdapter } from "@masterdns/cloud-providers";
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
  await f.d
    .insert(db.dnsRecords)
    .values({
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
