import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  addressHealthPolicies,
  addressHealthStates,
  auditLogs,
  cloudAccounts,
  cloudAddresses,
  cloudInstances,
  cloudInterfaces,
  cloudScanScopes,
  createDatabase,
  createScheduledRotationIncident,
  databaseNow,
  healthCheckConfigs,
  instanceAuthorizations,
  lockRotationContext,
  managedAddressSlots,
  probeGroups,
  rotationIncidents,
  rotationPolicies,
  rotationSchedules,
  users,
} from "@masterdns/db";
import { rotationScheduleSchema } from "@masterdns/contracts";
import type { AuthUser } from "../../auth/auth.types.js";

vi.mock("../../config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));

import { RotationSchedulesController } from "./rotation-schedules.controller.js";
import { RotationSchedulesService } from "./rotation-schedules.service.js";

let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
let service: RotationSchedulesService;
const name = `rotation_schedules_api_${randomUUID().replaceAll("-", "")}`;

beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  admin = createDatabase(root);
  await admin.client.unsafe(`create database "${name}"`);
  const url = new URL(root);
  url.pathname = `/${name}`;
  connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../../packages/db/drizzle", import.meta.url).pathname });
  service = new RotationSchedulesService({ db: connection.db } as never);
});

afterAll(async () => {
  await connection?.close();
  if (admin) {
    await admin.client.unsafe(`drop database if exists "${name}"`);
    await admin.close();
  }
});

async function fixture() {
  const [owner] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const actor = { id: owner!.id, username: owner!.username, email: null, role: "user", sessionId: randomUUID() } satisfies AuthUser;
  const [account] = await connection.db.insert(cloudAccounts).values({
    ownerUserId: actor.id,
    provider: "aws",
    name: "AWS",
    externalAccountId: randomUUID(),
    credentialCiphertext: "secret-ciphertext",
    credentialIv: "iv",
    credentialTag: "tag",
  }).returning();
  await connection.db.insert(cloudScanScopes).values({ accountId: account!.id, service: "ec2", region: "us-east-1", generation: 1 });
  const [instance] = await connection.db.insert(cloudInstances).values({
    accountId: account!.id,
    service: "ec2",
    region: "us-east-1",
    externalId: `i-${randomUUID()}`,
    metadata: { present: true },
    scanGeneration: 1,
  }).returning();
  const [iface] = await connection.db.insert(cloudInterfaces).values({
    instanceId: instance!.id,
    externalId: `eni-${randomUUID()}`,
    metadata: { deviceIndex: 0, primaryAddresses: ["192.0.2.1"] },
    scanGeneration: 1,
  }).returning();
  const [address] = await connection.db.insert(cloudAddresses).values({
    interfaceId: iface!.id,
    family: "4",
    kind: "host",
    address: "192.0.2.1",
    metadata: { providerMetadata: { awsAddressScope: "public" } },
    origin: "user",
    scanGeneration: 1,
  }).returning();
  const [slot] = await connection.db.insert(managedAddressSlots).values({
    interfaceId: iface!.id,
    family: "4",
    name: "primary",
    currentAddressId: address!.id,
    currentVersion: 1,
  }).returning();
  await connection.db.insert(instanceAuthorizations).values({ instanceId: instance!.id, managed: true, allowIpv4Rotation: true });
  const [config] = await connection.db.insert(healthCheckConfigs).values({ slotId: slot!.id, checkerType: "tcp", config: { port: 443 } }).returning();
  const [group] = await connection.db.insert(probeGroups).values({ ownerUserId: actor.id, name: "external" }).returning();
  const [healthPolicy] = await connection.db.insert(addressHealthPolicies).values({ slotId: slot!.id, family: "4", configId: config!.id, groupId: group!.id }).returning();
  await connection.db.insert(addressHealthStates).values({
    slotId: slot!.id,
    family: "4",
    addressId: address!.id,
    addressVersion: 1,
    configId: config!.id,
    configVersion: config!.revision,
    policyId: healthPolicy!.id,
    policyRevision: healthPolicy!.revision,
    groupRevision: group!.revision,
  });
  return { actor, account: account!, instance: instance!, address: address!, slot: slot!, healthPolicy: healthPolicy! };
}

async function dbNow() {
  return connection.db.transaction(tx => databaseNow(tx));
}

it("returns a canonical disabled schedule without creating state", async () => {
  const f = await fixture();

  const result = await service.get(f.actor, f.slot.id);

  expect(rotationScheduleSchema.parse(result)).toEqual(result);
  expect(result).toMatchObject({ slotId: f.slot.id, enabled: false, intervalMinutes: 1440, revision: 0, nextRunAt: null, activeIncidentId: null, pausedReason: null });
  expect(await connection.db.select().from(rotationSchedules).where(eq(rotationSchedules.slotId, f.slot.id))).toEqual([]);
});

it("enables a schedule from database time and initializes the disabled rotation policy defaults", async () => {
  const f = await fixture();
  const before = await dbNow();

  const result = await service.update(f.actor, f.slot.id, { revision: 0, enabled: true, intervalMinutes: 1440 });

  const after = await dbNow();
  const deadline = new Date(result.nextRunAt!);
  expect(deadline.getTime()).toBeGreaterThanOrEqual(before.getTime() + 1440 * 60_000);
  expect(deadline.getTime()).toBeLessThanOrEqual(after.getTime() + 1440 * 60_000);
  expect(result).toMatchObject({ enabled: true, intervalMinutes: 1440, revision: 1 });
  expect((await connection.db.select().from(rotationPolicies).where(eq(rotationPolicies.slotId, f.slot.id)))[0]).toMatchObject({ enabled: false, revision: 1, maxAttempts: 3, candidateWindowSeconds: 180 });
  expect((await connection.db.select().from(auditLogs).where(eq(auditLogs.resourceId, f.slot.id)))[0]).toMatchObject({ action: "rotation.schedule.update", ownerUserId: f.actor.id, actorUserId: f.actor.id });
});

it("rebases an interval change but leaves an identical PATCH completely unchanged", async () => {
  const f = await fixture();
  const enabled = await service.update(f.actor, f.slot.id, { revision: 0, enabled: true, intervalMinutes: 60 });
  const changed = await service.update(f.actor, f.slot.id, { revision: 1, enabled: true, intervalMinutes: 120 });
  const auditCount = (await connection.db.select().from(auditLogs).where(eq(auditLogs.resourceId, f.slot.id))).length;

  const unchanged = await service.update(f.actor, f.slot.id, { revision: 2, enabled: true, intervalMinutes: 120 });

  expect(new Date(changed.nextRunAt!).getTime()).toBeGreaterThan(new Date(enabled.nextRunAt!).getTime());
  expect(unchanged).toEqual(changed);
  expect((await connection.db.select().from(auditLogs).where(eq(auditLogs.resourceId, f.slot.id))).length).toBe(auditCount);
});

it("disables and re-enables without restoring an old deadline", async () => {
  const f = await fixture();
  const enabled = await service.update(f.actor, f.slot.id, { revision: 0, enabled: true, intervalMinutes: 30 });
  const disabled = await service.update(f.actor, f.slot.id, { revision: 1, enabled: false, intervalMinutes: 30 });
  const before = await dbNow();
  const reenabled = await service.update(f.actor, f.slot.id, { revision: 2, enabled: true, intervalMinutes: 30 });

  expect(disabled).toMatchObject({ enabled: false, revision: 2, nextRunAt: null });
  expect(reenabled.revision).toBe(3);
  expect(new Date(reenabled.nextRunAt!).getTime()).toBeGreaterThanOrEqual(before.getTime() + 30 * 60_000);
  expect(reenabled.nextRunAt).not.toBe(enabled.nextRunAt);
});

it("rejects stale revisions and cross-owner access without changing or revealing a schedule", async () => {
  const f = await fixture();
  const other = await fixture();
  const enabled = await service.update(f.actor, f.slot.id, { revision: 0, enabled: true, intervalMinutes: 60 });

  await expect(service.update(f.actor, f.slot.id, { revision: 0, enabled: false, intervalMinutes: 60 })).rejects.toMatchObject({ status: 409 });
  await expect(service.get(other.actor, f.slot.id)).rejects.toMatchObject({ status: 404 });
  await expect(service.update(other.actor, f.slot.id, { revision: 1, enabled: false, intervalMinutes: 60 })).rejects.toMatchObject({ status: 404 });
  await expect(service.resume(other.actor, f.slot.id, { revision: 1 })).rejects.toMatchObject({ status: 404 });
  expect(await service.get(f.actor, f.slot.id)).toEqual(enabled);
});

it("validates enabled targets while allowing a disabled schedule to remain editable", async () => {
  const invalid = await fixture();
  await connection.db.update(instanceAuthorizations).set({ allowIpv4Rotation: false }).where(eq(instanceAuthorizations.instanceId, invalid.instance.id));
  await expect(service.update(invalid.actor, invalid.slot.id, { revision: 0, enabled: true, intervalMinutes: 60 })).rejects.toMatchObject({ status: 409 });

  const f = await fixture();
  await service.update(f.actor, f.slot.id, { revision: 0, enabled: true, intervalMinutes: 60 });
  await connection.db.update(instanceAuthorizations).set({ allowIpv4Rotation: false }).where(eq(instanceAuthorizations.instanceId, f.instance.id));
  const disabled = await service.update(f.actor, f.slot.id, { revision: 1, enabled: false, intervalMinutes: 90 });

  expect(disabled).toMatchObject({ enabled: false, intervalMinutes: 90, revision: 2, nextRunAt: null });
  await expect(service.update(f.actor, f.slot.id, { revision: 2, enabled: true, intervalMinutes: 90 })).rejects.toMatchObject({ status: 409 });
});

it("keeps active execution state and rebases the deadline when the interval changes", async () => {
  const f = await fixture();
  await service.update(f.actor, f.slot.id, { revision: 0, enabled: true, intervalMinutes: 60 });
  await connection.db.update(rotationSchedules).set({ nextRunAt: new Date(0) }).where(eq(rotationSchedules.slotId, f.slot.id));
  const incident = await connection.db.transaction(async tx => createScheduledRotationIncident(tx, await lockRotationContext(tx, f.slot.id)));
  const [candidate] = await connection.db.insert(cloudAddresses).values({ interfaceId: f.slot.interfaceId, family: "4", kind: "host", address: "198.51.100.2", origin: "system", scanGeneration: 1 }).returning();
  await connection.db.update(managedAddressSlots).set({ candidateAddressId: candidate!.id, candidateVersion: 2 }).where(eq(managedAddressSlots.id, f.slot.id));
  await connection.db.update(rotationSchedules).set({ pausedReason: "attempts_exhausted" }).where(eq(rotationSchedules.slotId, f.slot.id));
  const before = await dbNow();

  const updated = await service.update(f.actor, f.slot.id, { revision: 1, enabled: true, intervalMinutes: 120 });

  const after = await dbNow();
  expect(updated).toMatchObject({ activeIncidentId: incident.id, pausedReason: "attempts_exhausted", intervalMinutes: 120, revision: 2 });
  expect(new Date(updated.nextRunAt!).getTime()).toBeGreaterThanOrEqual(before.getTime() + 120 * 60_000);
  expect(new Date(updated.nextRunAt!).getTime()).toBeLessThanOrEqual(after.getTime() + 120 * 60_000);
});

it("keeps an active incident associated and rebases the deadline when re-enabled", async () => {
  const f = await fixture();
  await service.update(f.actor, f.slot.id, { revision: 0, enabled: true, intervalMinutes: 75 });
  await connection.db.update(rotationSchedules).set({ nextRunAt: new Date(0) }).where(eq(rotationSchedules.slotId, f.slot.id));
  const incident = await connection.db.transaction(async tx => createScheduledRotationIncident(tx, await lockRotationContext(tx, f.slot.id)));
  const [candidate] = await connection.db.insert(cloudAddresses).values({ interfaceId: f.slot.interfaceId, family: "4", kind: "host", address: "198.51.100.4", origin: "system", scanGeneration: 1 }).returning();
  await connection.db.update(managedAddressSlots).set({ candidateAddressId: candidate!.id, candidateVersion: 2 }).where(eq(managedAddressSlots.id, f.slot.id));
  const disabled = await service.update(f.actor, f.slot.id, { revision: 1, enabled: false, intervalMinutes: 75 });
  const before = await dbNow();

  const reenabled = await service.update(f.actor, f.slot.id, { revision: 2, enabled: true, intervalMinutes: 75 });

  const after = await dbNow();
  expect(disabled).toMatchObject({ enabled: false, activeIncidentId: incident.id, nextRunAt: null, revision: 2 });
  expect(reenabled).toMatchObject({ enabled: true, activeIncidentId: incident.id, intervalMinutes: 75, revision: 3 });
  expect(new Date(reenabled.nextRunAt!).getTime()).toBeGreaterThanOrEqual(before.getTime() + 75 * 60_000);
  expect(new Date(reenabled.nextRunAt!).getTime()).toBeLessThanOrEqual(after.getTime() + 75 * 60_000);
});

it("resumes only the schedule, consumes the revision, and marks the old incident observation handled", async () => {
  const f = await fixture();
  await service.update(f.actor, f.slot.id, { revision: 0, enabled: true, intervalMinutes: 45 });
  await connection.db.update(rotationSchedules).set({ nextRunAt: new Date(0) }).where(eq(rotationSchedules.slotId, f.slot.id));
  const incident = await connection.db.transaction(async tx => createScheduledRotationIncident(tx, await lockRotationContext(tx, f.slot.id)));
  const [candidate] = await connection.db.insert(cloudAddresses).values({ interfaceId: f.slot.interfaceId, family: "4", kind: "host", address: "198.51.100.3", origin: "system", scanGeneration: 1 }).returning();
  await connection.db.update(managedAddressSlots).set({ candidateAddressId: candidate!.id, candidateVersion: 2 }).where(eq(managedAddressSlots.id, f.slot.id));
  await connection.db.update(rotationIncidents).set({ status: "paused", errorCode: "attempts_exhausted" }).where(eq(rotationIncidents.id, incident.id));
  await connection.db.update(rotationSchedules).set({ pausedReason: "attempts_exhausted" }).where(eq(rotationSchedules.slotId, f.slot.id));
  const before = await dbNow();

  const resumed = await service.resume(f.actor, f.slot.id, { revision: 1 });

  expect(resumed).toMatchObject({ revision: 2, activeIncidentId: incident.id, lastHandledIncidentId: incident.id, pausedReason: null });
  expect(new Date(resumed.nextRunAt!).getTime()).toBeGreaterThanOrEqual(before.getTime() + 45 * 60_000);
  expect((await connection.db.select().from(rotationIncidents).where(eq(rotationIncidents.id, incident.id)))[0]).toMatchObject({ status: "paused", errorCode: "attempts_exhausted" });
  await expect(service.resume(f.actor, f.slot.id, { revision: 1 })).rejects.toMatchObject({ status: 409 });
  expect((await connection.db.select().from(auditLogs).where(and(eq(auditLogs.resourceId, f.slot.id), eq(auditLogs.action, "rotation.schedule.resume"))))).toHaveLength(1);
});

it("records the latest completed incident as the configuration baseline", async () => {
  const f = await fixture();
  const earlier = new Date("2026-09-20T00:00:00.000Z");
  const later = new Date("2026-09-21T00:00:00.000Z");
  const ids = [randomUUID(), randomUUID()];
  await connection.db.insert(rotationIncidents).values([
    { id: ids[0], ownerUserId: f.actor.id, slotId: f.slot.id, family: "4", physicalKey: "one", sourceEventId: randomUUID(), trigger: "manual", status: "complete", phase: "complete", currentSegmentId: randomUUID(), authorizationRevision: 1, policyRevision: 1, addressVersion: 1, completedAt: earlier },
    { id: ids[1], ownerUserId: f.actor.id, slotId: f.slot.id, family: "4", physicalKey: "two", sourceEventId: randomUUID(), trigger: "manual", status: "complete", phase: "complete", currentSegmentId: randomUUID(), authorizationRevision: 1, policyRevision: 1, addressVersion: 1, completedAt: later },
  ]);

  const result = await service.update(f.actor, f.slot.id, { revision: 0, enabled: true, intervalMinutes: 60 });

  expect(result).toMatchObject({ lastHandledIncidentId: ids[1], lastCompletedAt: later.toISOString() });
});

it("exposes GET, PATCH, and resume through the schedule controller", async () => {
  const f = await fixture();
  const controller = new RotationSchedulesController(service);
  expect(await controller.get(f.actor, f.slot.id)).toMatchObject({ enabled: false, revision: 0 });
  expect(await controller.update(f.actor, f.slot.id, { revision: 0, enabled: true, intervalMinutes: 15 })).toMatchObject({ enabled: true, revision: 1 });
  await connection.db.update(rotationSchedules).set({ pausedReason: "manual_pause" }).where(eq(rotationSchedules.slotId, f.slot.id));
  expect(await controller.resume(f.actor, f.slot.id, { revision: 1 })).toMatchObject({ pausedReason: null, revision: 2 });
});
