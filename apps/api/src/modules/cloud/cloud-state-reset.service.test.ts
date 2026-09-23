import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { createDatabase, cloudAccounts, cloudAddresses, cloudEndpointLinks, cloudIdleIpCleanups, cloudInstances, cloudInterfaces, endpointAddresses, endpointPools, endpoints, managedAddressSlots, operations, operationSteps, providerAccounts, rotationIncidents, rotationAttempts, rotationPublications, rotationSteps, rotationLeases, rotationPolicies, users, zones, getCloudTargetsForSlots } from "@masterdns/db";
import { eq } from "drizzle-orm";
import { encryptJson } from "@masterdns/crypto";
const fake = vi.hoisted(() => ({ live: undefined as any, error: undefined as any, onInspect: undefined as (() => Promise<void>) | undefined }));
vi.mock("../../config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
vi.mock("@masterdns/cloud-providers", async original => ({ ...await original<any>(), createCloudAdapter: () => ({ verifyIdentity: async () => ({ externalAccountId: "123456789012" }), inspect: async () => { if (fake.error) throw fake.error; await fake.onInspect?.(); return fake.live; }, execute: () => { throw new Error("must_never_write_cloud"); } }) }));
import { CloudStateResetService } from "./cloud-state-reset.service.js";
let admin: ReturnType<typeof createDatabase>, connection: ReturnType<typeof createDatabase>, service: CloudStateResetService;
const name = `cloud_reset_${randomUUID().replaceAll("-", "")}`;
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL!; admin = createDatabase(root); await admin.client.unsafe(`create database "${name}"`);
  const url = new URL(root); url.pathname = `/${name}`; connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../../packages/db/drizzle", import.meta.url).pathname });
  service = new CloudStateResetService({ db: connection.db } as never);
});
afterAll(async () => { await connection?.close(); if (admin) { await admin.client.unsafe(`drop database if exists "${name}"`); await admin.close(); } });
async function fixture() {
  fake.error = undefined;
  fake.onInspect = undefined;
  const [owner] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const crypt = encryptJson({ kind: "access_key", accessKeyId: "fake", secretAccessKey: "fake" }, Buffer.alloc(32, 1));
  const [account] = await connection.db.insert(cloudAccounts).values({ ownerUserId: owner!.id, provider: "aws", name: "d2", externalAccountId: "123456789012", credentialCiphertext: crypt.ciphertext, credentialIv: crypt.iv, credentialTag: crypt.tag }).returning();
  const [instance] = await connection.db.insert(cloudInstances).values({ accountId: account!.id, service: "lightsail", region: "ap-northeast-1", externalId: `arn:aws:lightsail:ap-northeast-1:123456789012:Instance/${randomUUID()}`, scanGeneration: 1 }).returning();
  const [iface] = await connection.db.insert(cloudInterfaces).values({ instanceId: instance!.id, externalId: "primary", scanGeneration: 1 }).returning();
  const [address] = await connection.db.insert(cloudAddresses).values({ interfaceId: iface!.id, kind: "host", family: "4", address: "43.207.149.75", origin: "user", scanGeneration: 1, metadata: { providerMetadata: { awsAddressScope: "public" } } }).returning();
  const [slot] = await connection.db.insert(managedAddressSlots).values({ interfaceId: iface!.id, family: "4", name: "primary-public", currentAddressId: address!.id, currentVersion: 1 }).returning();
  const physicalKey = JSON.stringify(["aws",account!.externalAccountId,"lightsail",instance!.region,instance!.externalId]);
  const [incident] = await connection.db.insert(rotationIncidents).values({ ownerUserId: owner!.id, slotId: slot!.id, family: "4", trigger: "manual", physicalKey, sourceEventId: randomUUID(), status: "complete", terminatedAt: new Date(), currentSegmentId: randomUUID(), authorizationRevision: 1, policyRevision: 1, addressVersion: 1 }).returning();
  const [budget] = await connection.client`insert into rotation_budget_segments(id,incident_id,max_attempts) values (${incident!.currentSegmentId},${incident!.id},1) returning id`;
  const [attempt] = await connection.db.insert(rotationAttempts).values({ id: randomUUID(), incidentId: incident!.id, segmentId: budget!.id, sequence: 1, beforeInventory: {} }).returning();
  const [step] = await connection.db.insert(rotationSteps).values({ id: randomUUID(), attemptId: attempt!.id, sequence: 0, plan: { id: "step", action: "lightsail.static-ip.attach", resourceKey: "old", arguments: {}, destructive: true }, status: "pending" }).returning();
  await connection.db.insert(rotationLeases).values({ physicalKey, incidentId: incident!.id, unresolvedStepId: step!.id });
  await connection.db.insert(rotationPolicies).values({ slotId: slot!.id, enabled: false });
  fake.live = { ref: { accountId: account!.id, service: "lightsail", region: instance!.region, instanceId: instance!.externalId }, name: "Debian-2", nativeName: "Debian-2", state: "running", ipv6Only: false, interfaces: [{ id: "primary", addresses: [{ family: 4, primary: true, address: "54.95.217.122", allocationId: "new-ip", resourceId: "arn-new", metadata: { awsAddressScope: "public" } }] }] };
  return { actor: { id: owner!.id, role: "user" } as never, account: account!, instance: instance!, iface: iface!, address: address!, slot: slot!, incident: incident!, step: step!, physicalKey };
}
it("resets terminated uncertainty and aligns a fresh candidate on the same bound slot", async () => {
  const f = await fixture();
  const result = await service.reset(f.actor, f.instance.id);
  expect(result).toMatchObject({ reset: true, observedAddresses: ["54.95.217.122"], awaitingVerification: true });
  expect((await connection.db.select().from(rotationSteps).where(eq(rotationSteps.id, f.step.id)))[0]!.status).toBe("abandoned");
  expect((await connection.db.select().from(rotationLeases).where(eq(rotationLeases.physicalKey, f.physicalKey)))[0]).toMatchObject({ incidentId: null, unresolvedStepId: null });
  expect((await getCloudTargetsForSlots(connection.db, [f.slot.id])).get(f.slot.id)).toMatchObject({ currentAddressObserved: true, candidateAddressObserved: true, slot: { id: f.slot.id, currentVersion: 0, candidateVersion: 2 }, candidateAddress: { address: "54.95.217.122" } });
  expect((await connection.db.select().from(rotationPolicies).where(eq(rotationPolicies.slotId, f.slot.id)))[0]!.enabled).toBe(false);
  expect((await connection.db.select().from(cloudAddresses).where(eq(cloudAddresses.id, f.address.id)))[0]!.inventoryPresent).toBe(false);
});
it("preserves the bound canonical slot and endpoint address when a duplicate already points to the actual IP", async () => {
  const f = await fixture();
  const [pool] = await connection.db.insert(endpointPools).values({ ownerUserId: f.account.ownerUserId, name: "bound", strategy: "primary_backup" }).returning();
  const [endpoint] = await connection.db.insert(endpoints).values({ poolId: pool!.id, name: "cloud", addressMode: "cloud" }).returning();
  await connection.db.insert(cloudEndpointLinks).values({ endpointId: endpoint!.id, slotId: f.slot.id, family: "4" });
  const [published] = await connection.db.insert(endpointAddresses).values({ endpointId: endpoint!.id, family: "4", address: f.address.address, state: "current", source: "cloud" }).returning();
  const [actual] = await connection.db.insert(cloudAddresses).values({ interfaceId: f.iface.id, kind: "host", family: "4", address: "54.95.217.122", origin: "user", scanGeneration: 1, metadata: { providerMetadata: { awsAddressScope: "public" } } }).returning();
  await connection.db.insert(managedAddressSlots).values({ id: "00000000-0000-4000-8000-000000000001", interfaceId: f.iface.id, family: "4", name: "primary-public-duplicate", currentAddressId: actual!.id });
  await service.reset(f.actor, f.instance.id);
  expect((await connection.db.select().from(managedAddressSlots).where(eq(managedAddressSlots.id, f.slot.id)))[0]).toMatchObject({ currentAddressId: actual!.id, candidateAddressId: actual!.id, currentVersion: 0 });
  expect((await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.id, published!.id)))[0]).toEqual(published);
  expect((await connection.db.select().from(cloudEndpointLinks).where(eq(cloudEndpointLinks.endpointId, endpoint!.id)))[0]!.slotId).toBe(f.slot.id);
});
it("fences active and completed histories while retaining the enabled auto-rotation setting", async () => {
  const f = await fixture();
  await connection.db.update(rotationIncidents).set({ status: "active", terminatedAt: null }).where(eq(rotationIncidents.id, f.incident.id));
  await connection.db.update(rotationPolicies).set({ enabled: true }).where(eq(rotationPolicies.slotId, f.slot.id));
  await service.reset(f.actor, f.instance.id);
  expect((await connection.db.select().from(rotationIncidents).where(eq(rotationIncidents.id, f.incident.id)))[0]).toMatchObject({ status: "complete", terminatedAt: expect.any(Date), errorCode: "cloud_state_reset" });
  expect((await connection.db.select().from(rotationPolicies).where(eq(rotationPolicies.slotId, f.slot.id)))[0]!.enabled).toBe(true);
  await connection.db.update(rotationIncidents).set({ terminatedAt: null }).where(eq(rotationIncidents.id, f.incident.id));
  await connection.db.update(rotationSteps).set({ status: "applied" }).where(eq(rotationSteps.id, f.step.id));
  await service.reset(f.actor, f.instance.id);
  expect((await connection.db.select().from(rotationIncidents).where(eq(rotationIncidents.id, f.incident.id)))[0]!.terminatedAt).toBeInstanceOf(Date);
  expect((await connection.db.select().from(rotationSteps).where(eq(rotationSteps.id, f.step.id)))[0]!.status).toBe("applied");
});
it("cancels publications without a rotation incident and cleanup blocks for a newly discovered IP", async () => {
  const f = await fixture();
  const [operation] = await connection.db.insert(operations).values({ ownerUserId: f.account.ownerUserId, source: "sync", idempotencyKey: randomUUID(), resourceType: "pool", status: "pending" }).returning();
  const [provider] = await connection.db.insert(providerAccounts).values({ ownerUserId: f.account.ownerUserId, provider: "cloudflare", name: "DNS", credentialCiphertext: "test", credentialIv: "iv", credentialTag: "tag" }).returning();
  const [zone] = await connection.db.insert(zones).values({ providerAccountId: provider!.id, externalId: "test", nameAscii: "example.com" }).returning();
  const [running] = await connection.db.insert(operationSteps).values({ operationId: operation!.id, sequence: 0, providerAccountId: provider!.id, zoneId: zone!.id, action: "create", status: "running", input: {}, nextRetryAt: new Date() }).returning();
  const [publication] = await connection.db.insert(rotationPublications).values({ slotId: f.slot.id, addressId: f.address.id, addressVersion: 1, operationId: operation!.id }).returning();
  const item = { region: f.instance.region, name: "new", address: "54.95.217.122", arn: "arn-new", createdAt: new Date().toISOString(), status: "pending" as const };
  const [batch] = await connection.db.insert(cloudIdleIpCleanups).values({ accountId: f.account.id, ownerUserId: f.account.ownerUserId, actorUserId: f.account.ownerUserId, externalAccountId: f.account.externalAccountId!, credentialFingerprint: "test", regions: [f.instance.region], items: [item, { ...item, address: "192.0.2.99" }], expiresAt: new Date(Date.now() + 60000) }).returning();
  await service.reset(f.actor, f.instance.id);
  expect((await connection.db.select().from(rotationPublications).where(eq(rotationPublications.id, publication!.id)))[0]!.errorCode).toBe("manual_terminated");
  expect((await connection.db.select().from(operations).where(eq(operations.id, operation!.id)))[0]!.status).toBe("superseded");
  expect((await connection.db.select().from(operationSteps).where(eq(operationSteps.id, running!.id)))[0]).toMatchObject({ status: "skipped", nextRetryAt: null });
  const [resetBatch] = await connection.db.select().from(cloudIdleIpCleanups).where(eq(cloudIdleIpCleanups.id, batch!.id));
  expect(resetBatch!.items).toMatchObject([{ status: "skipped", reason: "cloud_state_reset" }, { status: "pending" }]);
});
it("holds instance and physical admission fences during cloud inspection, including an absent lease", async () => {
  const f = await fixture();
  await connection.db.delete(rotationLeases).where(eq(rotationLeases.physicalKey, f.physicalKey));
  fake.onInspect = async () => {
    await expect(connection.client`select id from cloud_instances where id=${f.instance.id} for update nowait`).rejects.toMatchObject({ code: "55P03" });
    // The insert is uncommitted during inspection, so another insertion cannot
    // acquire this previously absent lease. Use a bounded database lock timeout.
    await expect(connection.client.begin(async tx => {
      await tx`set local lock_timeout = '100ms'`;
      await tx`insert into rotation_leases(physical_key) values(${f.physicalKey}) on conflict do nothing`;
    })).rejects.toMatchObject({ code: "55P03" });
  };
  await service.reset(f.actor, f.instance.id);
});
it("rejects mismatching cloud identity without clearing local state", async () => {
  const f = await fixture(); fake.live.ref.instanceId = "other-instance";
  await expect(service.reset(f.actor, f.instance.id)).rejects.toMatchObject({ status: 409 });
  expect((await connection.db.select().from(rotationSteps).where(eq(rotationSteps.id, f.step.id)))[0]!.status).toBe("pending");
});
it("leaves local blockers intact if cloud reading fails", async () => {
  const f = await fixture(); fake.error = new Error("denied");
  await expect(service.reset(f.actor, f.instance.id)).rejects.toThrow();
  expect((await connection.db.select().from(rotationSteps).where(eq(rotationSteps.id, f.step.id)))[0]!.status).toBe("pending");
});
it("does not allow another user to reset the instance", async () => {
  const f = await fixture();
  await expect(service.reset({ id: randomUUID(), role: "user" } as never, f.instance.id)).rejects.toMatchObject({ status: 404 });
});
