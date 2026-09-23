import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import * as db from "@masterdns/db";
import { fixture } from "./rotation-test-utils.js";
import { publicationAuthorizationError } from "./rotation-publication.service.js";

it("keeps a stopped instance out of new rotations and DNS publication", async () => {
  const f = await fixture();
  const physicalKey = JSON.stringify(["aws", f.account.externalAccountId, "ec2", "us-east-1", f.instance.externalId]);
  await f.d.insert(db.cloudInstanceControls).values({ physicalKey, powerHold: "traffic_limit" });
  const c = await f.d.transaction(tx => db.lockRotationContext(tx, f.slot.id));
  expect(c.lifecycleBlocked).toBe(true);
  expect(db.rotationAuthorizationError(c, "manual")).toBe("instance_lifecycle_busy");
  expect(publicationAuthorizationError(c)).toBe("instance_lifecycle_busy");
  await f.d.update(db.cloudInstanceControls).set({ powerHold: null }).where(eq(db.cloudInstanceControls.physicalKey, physicalKey));
  const resumed = await f.d.transaction(tx => db.lockRotationContext(tx, f.slot.id));
  expect(resumed.lifecycleBlocked).toBe(false);
  expect(publicationAuthorizationError(resumed)).toBeUndefined();
});

it("protects a queued instance deletion from new address references across aliases", async () => {
  const f = await fixture();
  const physicalKey = JSON.stringify(["aws", f.account.externalAccountId, "ec2", "us-east-1", f.instance.externalId]);
  const [job] = await f.d.insert(db.cloudLifecycleOperations).values({ instanceId: f.instance.id, physicalKey, ownerUserId: f.account.ownerUserId, actorUserId: f.account.ownerUserId, action: "delete", source: "user", externalAccountId: f.account.externalAccountId!, credentialFingerprint: "test", protectedAddresses: [f.address.address] }).returning();
  expect(await f.d.transaction(tx => db.idleIpAddressReleasing(tx, f.address.address))).toBe(true);
  expect(await f.d.transaction(tx => db.instanceLifecycleBlocksRotation(tx, physicalKey))).toBe(true);
  await f.d.update(db.cloudLifecycleOperations).set({ status: "failed" }).where(eq(db.cloudLifecycleOperations.id, job!.id));
  expect(await f.d.transaction(tx => db.idleIpAddressReleasing(tx, f.address.address))).toBe(false);
});
