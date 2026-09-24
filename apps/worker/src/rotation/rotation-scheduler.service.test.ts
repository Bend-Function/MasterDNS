import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { addressHealthPolicies, addressHealthStates, cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, cloudScanScopes, createDatabase, createRotationIncident, createManualRotationIncident, createScheduledRotationIncident, databaseNow, healthCheckConfigs, instanceAuthorizations, lockRotationContext, managedAddressSlots, probeGroups, resumeRotationIncident, resumeRotationSchedule, rotationBudgetSegments, rotationIncidents, rotationPolicies, rotationSchedules, terminateRotationIncident, updateRotationScheduleConfiguration, users } from "@masterdns/db";
vi.mock("../env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { RotationSchedulerService } from "./rotation-scheduler.service.js";
import { RotationStore } from "./rotation-store.js";
import { RotationProcessor } from "./rotation.processor.js";
import { RotationRecoveryService } from "./rotation-recovery.service.js";
type AuthUser = { id: string; username: string; email: null; role: "user"; sessionId: string };
let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
const name = `rotation_scheduler_${randomUUID().replaceAll("-", "")}`;
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  admin = createDatabase(root);
  await admin.client.unsafe(`create database "${name}"`);
  const url = new URL(root); url.pathname = `/${name}`;
  connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../packages/db/drizzle", import.meta.url).pathname });
});
afterAll(async () => { await connection?.close(); if (admin) { await admin.client.unsafe(`drop database if exists "${name}"`); await admin.close(); } });
function scheduler(add: (_name: string, data: { incidentId: string }) => Promise<unknown> = async () => undefined) {
  return new RotationSchedulerService({ db: connection.db } as never, { rotation: { add } } as never);
}
async function schedule(slotId: string) { return (await connection.db.select().from(rotationSchedules).where(eq(rotationSchedules.slotId, slotId)))[0]!; }
async function incidents(slotId: string) { return connection.db.select().from(rotationIncidents).where(eq(rotationIncidents.slotId, slotId)); }
async function admitted(slotId: string) { return connection.db.transaction(async tx => createScheduledRotationIncident(tx, await lockRotationContext(tx, slotId))); }
async function configure(slotId: string, enabled: boolean, intervalMinutes = 60) {
  return connection.db.transaction(async tx => { await lockRotationContext(tx, slotId); return updateRotationScheduleConfiguration(tx, slotId, { revision: (await schedule(slotId)).revision, enabled, intervalMinutes }); });
}
async function resume(slotId: string) {
  return connection.db.transaction(async tx => { await lockRotationContext(tx, slotId); return resumeRotationSchedule(tx, slotId, (await schedule(slotId)).revision); });
}
async function finish(id: string, at = new Date()) {
  await connection.db.update(rotationIncidents).set({ status: "complete", phase: "complete", completedAt: at, updatedAt: at, errorCode: null }).where(eq(rotationIncidents.id, id));
}
async function fixture(slotId = randomUUID()) {
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
    id: slotId,
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
  await connection.db.insert(rotationPolicies).values({ slotId: slot!.id });
  await connection.db.insert(rotationSchedules).values({ slotId: slot!.id, enabled: true, intervalMinutes: 60, nextRunAt: new Date(0) });
  return { actor, account: account!, instance: instance!, address: address!, slot: slot!, healthPolicy: healthPolicy! };
}


it("serializes concurrent scans and admits only one overdue event after multiple missed intervals", async () => {
  const f = await fixture();
  const jobs: string[] = [];
  await Promise.all(Array.from({ length: 6 }, () => scheduler(async (_name, data) => { jobs.push(data.incidentId); }).scan()));
  await scheduler().scan();
  const rows = await incidents(f.slot.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ trigger: "scheduled", sourceEventId: "scheduled-1-1970-01-01T00:00:00.000Z" });
  expect(await schedule(f.slot.id)).toMatchObject({ activeIncidentId: rows[0]!.id, nextRunAt: null, revision: 1 });
  expect(jobs.filter(id => id === rows[0]!.id)).toHaveLength(1);
  expect(await connection.db.select().from(rotationBudgetSegments).where(eq(rotationBudgetSegments.incidentId, rows[0]!.id))).toHaveLength(1);
});
it("rolls back failed admission and lets later scans retry", async () => {
  const f = await fixture();
  await connection.client.unsafe(`create function fail_scheduled_audit() returns trigger language plpgsql as $$ begin if new.action = 'rotation.scheduled' then raise exception 'injected_admission_failure'; end if; return new; end $$`);
  await connection.client.unsafe(`create trigger fail_scheduled_audit before insert on audit_logs for each row execute function fail_scheduled_audit()`);
  try { await scheduler().scan(); } finally { await connection.client.unsafe(`drop trigger fail_scheduled_audit on audit_logs`); await connection.client.unsafe(`drop function fail_scheduled_audit()`); }
  expect(await incidents(f.slot.id)).toEqual([]);
  expect(await schedule(f.slot.id)).toMatchObject({ activeIncidentId: null, nextRunAt: new Date(0) });
  await scheduler().scan();
  expect(await incidents(f.slot.id)).toHaveLength(1);
});
it("recovers a lost post-commit queue wakeup without creating another incident", async () => {
  const f = await fixture();
  await scheduler(async () => { throw new Error("redis_unavailable"); }).scan();
  const [incident] = await incidents(f.slot.id);
  expect(incident).toBeDefined();
  const jobs: string[] = [];
  await new RotationRecoveryService({ db: connection.db } as never, { rotation: { add: async (_name: string, data: { incidentId: string }) => { jobs.push(data.incidentId); } } } as never).recover();
  expect(jobs).toContain(incident!.id);
  await scheduler().scan();
  expect(await incidents(f.slot.id)).toHaveLength(1);
});
it.each(["manual", "health"] as const)("defers to existing %s work and rebases once from its completion", async trigger => {
  const f = await fixture();
  if (trigger === "health") {
    await connection.db.update(rotationPolicies).set({ enabled: true }).where(eq(rotationPolicies.slotId, f.slot.id));
    await connection.db.update(addressHealthStates).set({ healthState: "unhealthy", latestDecision: "failure", consecutiveFailures: 3, lastRoundId: randomUUID(), lastCheckedAt: new Date(), evidenceExpiresAt: new Date(Date.now() + 60000) }).where(eq(addressHealthStates.slotId, f.slot.id));
  }
  const incident = await connection.db.transaction(async tx => {
    const c = await lockRotationContext(tx, f.slot.id);
    return trigger === "manual" ? createManualRotationIncident(tx, c, randomUUID(), f.actor.id) : createRotationIncident(tx, c, randomUUID());
  });
  await scheduler().scan();
  expect(await incidents(f.slot.id)).toHaveLength(1);
  const at = new Date();
  await finish(incident.id, at);
  await scheduler().scan();
  const handled = await schedule(f.slot.id);
  expect(handled).toMatchObject({ activeIncidentId: null, lastHandledIncidentId: incident.id, lastCompletedAt: at, nextRunAt: new Date(at.getTime() + 3600000), revision: 1 });
  await scheduler().scan();
  expect(await schedule(f.slot.id)).toEqual(handled);
});
it("uses the current interval on completion without re-enabling disabled or unpausing paused schedules", async () => {
  for (const state of ["changed", "disabled", "paused"]) {
    const f = await fixture(); const incident = await admitted(f.slot.id);
    await configure(f.slot.id, state !== "disabled", 120);
    if (state === "paused") await connection.db.update(rotationSchedules).set({ pausedReason: "user_pause" }).where(eq(rotationSchedules.slotId, f.slot.id));
    const at = new Date(); await finish(incident.id, at); await scheduler().scan();
    expect(await schedule(f.slot.id)).toMatchObject({ enabled: state !== "disabled", pausedReason: state === "paused" ? "user_pause" : null, activeIncidentId: null, lastCompletedAt: at, intervalMinutes: 120, revision: 2, nextRunAt: state === "changed" ? new Date(at.getTime() + 7200000) : null });
  }
});
it.each(["paused", "exhausted", "terminated"] as const)("pauses the schedule on %s outcomes", async state => {
  const f = await fixture(); const incident = await admitted(f.slot.id);
  if (state === "terminated") await connection.db.transaction(tx => terminateRotationIncident(tx, incident.id, f.actor.id));
  else await connection.db.update(rotationIncidents).set({ status: state, errorCode: "permission_denied", updatedAt: new Date() }).where(eq(rotationIncidents.id, incident.id));
  await scheduler().scan();
  expect(await schedule(f.slot.id)).toMatchObject({ pausedReason: state === "terminated" ? "manual_terminated" : "permission_denied", nextRunAt: null, lastHandledIncidentId: incident.id });
});
it("does not consume an explicit schedule resume again, but handles the same incident's later success", async () => {
  const f = await fixture(); const incident = await admitted(f.slot.id);
  await connection.db.update(rotationIncidents).set({ status: "paused", errorCode: "manual_pause", updatedAt: new Date() }).where(eq(rotationIncidents.id, incident.id));
  await scheduler().scan(); await resume(f.slot.id);
  const resumed = await schedule(f.slot.id);
  await scheduler().scan();
  expect(await schedule(f.slot.id)).toEqual(resumed);
  await connection.db.update(rotationSchedules).set({ nextRunAt: new Date(0) }).where(eq(rotationSchedules.slotId, f.slot.id));
  await scheduler().scan(); expect(await incidents(f.slot.id)).toHaveLength(1);
  await connection.db.transaction(async tx => resumeRotationIncident(tx, await lockRotationContext(tx, f.slot.id), incident.id, f.actor.id));
  const at = new Date(); await finish(incident.id, at); await scheduler().scan();
  expect(await schedule(f.slot.id)).toMatchObject({ activeIncidentId: null, pausedReason: null, lastCompletedAt: at, nextRunAt: new Date(at.getTime() + 3600000) });
});
it.each(["paused", "terminated"] as const)("detects a new %s of the same incident entirely between scans despite unrelated PATCH", async outcome => {
  const f = await fixture(); const incident = await admitted(f.slot.id);
  await connection.db.update(rotationIncidents).set({ status: "paused", errorCode: "manual_pause", updatedAt: sql`clock_timestamp()` }).where(eq(rotationIncidents.id, incident.id));
  await scheduler().scan(); await resume(f.slot.id);
  await connection.db.transaction(async tx => resumeRotationIncident(tx, await lockRotationContext(tx, f.slot.id), incident.id, f.actor.id));
  if (outcome === "terminated") await connection.db.transaction(tx => terminateRotationIncident(tx, incident.id, f.actor.id));
  else await connection.db.update(rotationIncidents).set({ status: "paused", errorCode: "manual_pause", updatedAt: sql`clock_timestamp()` }).where(eq(rotationIncidents.id, incident.id));
  await configure(f.slot.id, true, 120); await scheduler().scan();
  expect(await schedule(f.slot.id)).toMatchObject({ pausedReason: outcome === "terminated" ? "manual_terminated" : "manual_pause", nextRunAt: null, revision: 3 });
});
it("retains the same incident through throttling, candidate checks, convergence and TTL waits", async () => {
  const f = await fixture(); const incident = await admitted(f.slot.id);
  for (const phase of ["cloud", "candidate", "publish", "cleanup"] as const) {
    await connection.db.update(rotationIncidents).set({ phase, errorCode: "rate_limited", nextRunAt: new Date(Date.now() + 600000) }).where(eq(rotationIncidents.id, incident.id));
    await scheduler().scan();
    expect(await schedule(f.slot.id)).toMatchObject({ activeIncidentId: incident.id, pausedReason: null, nextRunAt: null });
    expect(await incidents(f.slot.id)).toHaveLength(1);
  }
});
it.each(["disable", "pause", "interval"] as const)("rechecks %s changes after waiting for the context lock", async change => {
  const f = await fixture();
  let release!: () => void; let locked!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  const edit = connection.db.transaction(async tx => {
    await lockRotationContext(tx, f.slot.id); locked(); await barrier;
    if (change === "pause") await tx.update(rotationSchedules).set({ pausedReason: "manual_pause" }).where(eq(rotationSchedules.slotId, f.slot.id));
    else await updateRotationScheduleConfiguration(tx, f.slot.id, { revision: 1, enabled: change !== "disable", intervalMinutes: 120 });
  });
  await acquired;
  const scanning = scheduler().scan();
  try {
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      const rows = await admin.client`select pid from pg_stat_activity where datname = ${name} and wait_event_type = 'Lock'`;
      waiting = rows.length > 0;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(waiting).toBe(true);
  } finally { release(); await Promise.all([edit, scanning]); }
  expect(await incidents(f.slot.id)).toEqual([]);
  expect(await schedule(f.slot.id)).toMatchObject(change === "pause" ? { pausedReason: "manual_pause" } : { enabled: change !== "disable", revision: 2 });
});
it("does not let a blocked prefix of more than 200 schedules starve a later eligible slot", async () => {
  const f = await fixture("ffffffff-ffff-4fff-8fff-ffffffffffff");
  const ids = Array.from({ length: 205 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
  await connection.db.insert(managedAddressSlots).values(ids.map((id, n) => ({ id, interfaceId: f.slot.interfaceId, family: "4" as const, name: `blocked-${n}`, currentAddressId: f.address.id, currentVersion: 1 })));
  await connection.db.insert(rotationSchedules).values(ids.map(slotId => ({ slotId, enabled: true, nextRunAt: new Date(0) })));
  await scheduler().scan();
  expect(await incidents(f.slot.id)).toHaveLength(1);
  expect(await incidents(ids[0]!)).toEqual([]);
}, 30000);

it("preserves the exact consumed pause timestamp through an unrelated configuration edit", async () => {
  const f = await fixture(); const incident = await admitted(f.slot.id);
  await connection.db.update(rotationIncidents).set({ status: "paused", errorCode: "manual_pause", updatedAt: sql`'2026-09-24T00:00:00.123456Z'::timestamptz` }).where(eq(rotationIncidents.id, incident.id));
  await scheduler().scan(); await resume(f.slot.id); await configure(f.slot.id, true, 90);
  const before = await schedule(f.slot.id);
  await scheduler().scan();
  expect(await schedule(f.slot.id)).toEqual(before);
  expect(before.pausedReason).toBeNull();
});
it("processes an unseen manual completion before admission but preserves a newer configuration baseline", async () => {
  const f = await fixture();
  const incident = await connection.db.transaction(async tx => createManualRotationIncident(tx, await lockRotationContext(tx, f.slot.id), randomUUID(), f.actor.id));
  const at = new Date(); await finish(incident.id, at);
  await scheduler().scan();
  expect(await incidents(f.slot.id)).toHaveLength(1);
  expect(await schedule(f.slot.id)).toMatchObject({ nextRunAt: new Date(at.getTime() + 3600000), lastHandledIncidentId: incident.id });
  const newer = await fixture();
  const old = await connection.db.transaction(async tx => createManualRotationIncident(tx, await lockRotationContext(tx, newer.slot.id), randomUUID(), newer.actor.id));
  await finish(old.id, new Date(Date.now() - 86400000));
  await configure(newer.slot.id, true, 120);
  const baseline = await schedule(newer.slot.id);
  await scheduler().scan();
  expect(await schedule(newer.slot.id)).toEqual(baseline);
  expect(await incidents(newer.slot.id)).toHaveLength(1);
});
it("keeps accepted work when disabling wins after admission, without scheduling another cycle", async () => {
  const f = await fixture();
  await scheduler().scan();
  const [incident] = await incidents(f.slot.id);
  await configure(f.slot.id, false);
  await scheduler().scan();
  expect(await schedule(f.slot.id)).toMatchObject({ enabled: false, activeIncidentId: incident!.id, nextRunAt: null });
  expect((await incidents(f.slot.id))[0]).toMatchObject({ status: "active" });
  await finish(incident!.id); await scheduler().scan();
  expect(await schedule(f.slot.id)).toMatchObject({ enabled: false, activeIncidentId: null, nextRunAt: null });
});
it("converges a pre-migration null observation marker once and preserves an explicit subsequent resume", async () => {
  const f = await fixture(); const incident = await admitted(f.slot.id);
  await connection.db.update(rotationIncidents).set({ status: "paused", errorCode: "manual_pause", updatedAt: sql`clock_timestamp()` }).where(eq(rotationIncidents.id, incident.id));
  await connection.db.update(rotationSchedules).set({ lastHandledIncidentId: incident.id, lastHandledIncidentUpdatedAt: null }).where(eq(rotationSchedules.slotId, f.slot.id));
  await scheduler().scan();
  expect(await schedule(f.slot.id)).toMatchObject({ pausedReason: "manual_pause" });
  expect((await schedule(f.slot.id)).lastHandledIncidentUpdatedAt).not.toBeNull();
  await resume(f.slot.id); const resumed = await schedule(f.slot.id); await scheduler().scan();
  expect(await schedule(f.slot.id)).toEqual(resumed);
});

it.each(["paused", "exhausted"] as const)("does not turn unchanged %s worker wakeups into new schedule pauses", async status => {
  const f = await fixture(); const incident = await admitted(f.slot.id);
  const code = status === "paused" ? "manual_pause" : "attempts_exhausted";
  await connection.db.update(rotationIncidents).set({ status, errorCode: code, updatedAt: sql`'2026-09-24T00:00:00.654321Z'::timestamptz` }).where(eq(rotationIncidents.id, incident.id));
  if (status === "exhausted") await connection.db.update(rotationBudgetSegments).set({ attemptsUsed: 3, exhausted: true }).where(eq(rotationBudgetSegments.incidentId, incident.id));
  await scheduler().scan(); await resume(f.slot.id);
  const resumed = await schedule(f.slot.id);
  const store = new RotationStore({ db: connection.db } as never);
  const processor = new RotationProcessor(store, { adapter: async () => { throw new Error("unexpected_cloud_api"); } } as never, {} as never);
  await processor.run(incident.id); await processor.run(incident.id);
  await scheduler().scan();
  expect(await schedule(f.slot.id)).toEqual(resumed);
  expect((await incidents(f.slot.id))[0]).toMatchObject({ status, errorCode: code });
  await connection.db.transaction(async tx => resumeRotationIncident(tx, await lockRotationContext(tx, f.slot.id), incident.id, f.actor.id));
  await store.pause(incident.id, code); await scheduler().scan();
  expect(await schedule(f.slot.id)).toMatchObject({ pausedReason: code, nextRunAt: null });
});
it("clears a terminated association already consumed by schedule resume without undoing that resume", async () => {
  const f = await fixture(); const incident = await admitted(f.slot.id);
  await new RotationStore({ db: connection.db } as never).pause(incident.id, "manual_pause");
  await scheduler().scan();
  await connection.db.transaction(tx => terminateRotationIncident(tx, incident.id, f.actor.id));
  await resume(f.slot.id);
  const resumed = await schedule(f.slot.id);
  await scheduler().scan();
  expect(await schedule(f.slot.id)).toMatchObject({ activeIncidentId: null, pausedReason: null, revision: resumed.revision, nextRunAt: resumed.nextRunAt });
  await connection.db.update(rotationSchedules).set({ nextRunAt: new Date(0) }).where(eq(rotationSchedules.slotId, f.slot.id));
  await scheduler().scan();
  expect(await incidents(f.slot.id)).toHaveLength(2);
});
