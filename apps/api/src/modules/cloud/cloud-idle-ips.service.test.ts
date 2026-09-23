import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, users, cloudAccounts, cloudIdleIpCleanups, setCloudRotationLimitPolicy, reserveCloudRotationWrite, idleIpAddressReleasing, cloudInstances, cloudInterfaces, cloudAddresses, managedAddressSlots, rotationIncidents, rotationBudgetSegments, rotationAttempts, rotationSteps, rotationLeases, rotationResources } from "@masterdns/db";
import { CloudError, makeRotationStep, type RotationAction } from "@masterdns/cloud-providers";
import { encryptJson } from "@masterdns/crypto";
const fake = vi.hoisted(() => ({ calls: 0, items: [] as any[], release: undefined as any, observe: undefined as any }));
vi.mock("../../config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
vi.mock("@masterdns/cloud-providers", async original => ({ ...await original<any>(), createCloudAdapter: () => ({
  verifyIdentity: async () => ({ externalAccountId: "123456789012" }), listScopes: async () => ["ap-northeast-1", "ap-southeast-1"],
  listIdleStaticIps: async (region: string) => fake.items.filter(item => item.region === region),
  releaseIdleStaticIp: async (target: any) => { fake.calls++; return fake.release ? fake.release(target) : { status: "released" }; },
  observeIdleStaticIp: async () => fake.observe ? fake.observe() : ({ status: "released" }),
}) }));
import { CloudIdleIpsService } from "./cloud-idle-ips.service.js";
let admin: ReturnType<typeof createDatabase>, connection: ReturnType<typeof createDatabase>, service: CloudIdleIpsService;
const name = `idle_ips_${randomUUID().replaceAll("-", "")}`;
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL!;
  admin = createDatabase(root); await admin.client.unsafe(`create database "${name}"`);
  const url = new URL(root); url.pathname = `/${name}`; connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../../packages/db/drizzle", import.meta.url).pathname });
  service = new CloudIdleIpsService({ db: connection.db } as never);
});
afterAll(async () => { await connection?.close(); if (admin) { await admin.client.unsafe(`drop database if exists "${name}"`); await admin.close(); } });
beforeEach(async () => { await connection.client.unsafe("truncate users, cloud_rotation_buckets, cloud_rotation_limit_switches cascade"); });
async function fixture() {
  fake.calls = 0; fake.release = undefined; fake.observe = undefined;
  const [owner] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const encrypted = encryptJson({ kind: "access_key", accessKeyId: "test-key", secretAccessKey: "test-secret" }, Buffer.alloc(32, 1));
  const [account] = await connection.db.insert(cloudAccounts).values({ ownerUserId: owner!.id, provider: "aws", name: "AWS", externalAccountId: "123456789012", regions: ["ap-northeast-1"], credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag }).returning();
  fake.items = [{ region: "ap-northeast-1", name: randomUUID(), address: "203.0.113.9", arn: `arn:aws:lightsail:ap-northeast-1:123456789012:StaticIp/${randomUUID()}`, createdAt: "2026-09-01T00:00:00.000Z" }];
  await connection.db.transaction(tx => setCloudRotationLimitPolicy(tx, account!.id, "lightsail", 80, false));
  return { account: account!, actor: { id: owner!.id, role: "user" as const } };
}

async function unresolvedRotation(f: Awaited<ReturnType<typeof fixture>>, action: RotationAction, active = false) {
  const region = "ap-northeast-1", attemptId = randomUUID(), segmentId = randomUUID(), physicalKey = randomUUID();
  const original = { ...fake.items[0], name: "original-static", address: "203.0.113.8", arn: "arn:aws:lightsail:ap-northeast-1:123456789012:StaticIp/original" };
  const ipv6 = action.startsWith("lightsail.ipv6.");
  const [instance] = await connection.db.insert(cloudInstances).values({ accountId: f.account.id, service: "lightsail", region, externalId: `arn:aws:lightsail:${region}:123456789012:Instance/${randomUUID()}`, scanGeneration: 1 }).returning();
  const [iface] = await connection.db.insert(cloudInterfaces).values({ instanceId: instance!.id, externalId: "primary", scanGeneration: 1 }).returning();
  const [address] = await connection.db.insert(cloudAddresses).values({ interfaceId: iface!.id, family: ipv6 ? "6" : "4", kind: "host", address: ipv6 ? "2001:db8::1" : original.address, remoteAllocationId: ipv6 ? null : original.name, origin: "user", scanGeneration: 1 }).returning();
  const [slot] = await connection.db.insert(managedAddressSlots).values({ interfaceId: iface!.id, family: ipv6 ? "6" : "4", name: "primary", currentAddressId: address!.id }).returning();
  const [incident] = await connection.db.insert(rotationIncidents).values({ ownerUserId: f.actor.id, slotId: slot!.id, family: slot!.family, physicalKey, sourceEventId: randomUUID(), trigger: "manual", status: active ? "active" : "complete", phase: active ? "cloud" : "complete", currentSegmentId: segmentId, currentAttemptId: attemptId, authorizationRevision: 1, policyRevision: 1, addressVersion: 1, terminatedAt: active ? null : new Date() }).returning();
  await connection.db.insert(rotationBudgetSegments).values({ id: segmentId, incidentId: incident!.id, maxAttempts: 1 });
  const ref = { accountId: f.account.id, service: "lightsail" as const, region, instanceId: instance!.externalId };
  const selected = { address: address!.address, family: ipv6 ? 6 as const : 4 as const, primary: true, ...(ipv6 ? {} : { allocationId: original.name, resourceId: original.arn }) };
  const before = { ref, nativeName: "one", name: "one", state: "running", interfaces: [{ id: "primary", addresses: [selected] }] };
  const plan = makeRotationStep(action, { slot: { ...ref, interfaceId: "primary", slotId: slot!.id, address: selected.address, family: selected.family }, attemptId, phase: action.endsWith("release") ? "post_publish_cleanup" : "rotation", before }, 0);
  await connection.db.insert(rotationAttempts).values({ id: attemptId, incidentId: incident!.id, segmentId, sequence: 1, beforeInventory: before });
  await connection.db.insert(rotationSteps).values({ id: plan.id, attemptId, sequence: 0, plan, status: "pending" });
  await connection.db.insert(rotationLeases).values({ physicalKey, incidentId: incident!.id, unresolvedStepId: plan.id });
  return { original, attemptId, incident: incident!, plan, physicalKey };
}
it("freezes configured-region preview and releases each confirmed item once", async () => {
  const f = await fixture(); fake.items.push({ ...fake.items[0], region: "ap-southeast-1" });
  const preview = await service.preview(f.actor as never, f.account.id);
  expect(preview.items).toHaveLength(1); expect(fake.calls).toBe(0);
  await expect(service.execute(f.actor as never, f.account.id, preview.id, 0)).rejects.toThrow("confirmation_required");
  await service.confirm(f.actor as never, f.account.id, preview.id);
  const [a, b] = await Promise.all([service.execute(f.actor as never, f.account.id, preview.id, 0), service.execute(f.actor as never, f.account.id, preview.id, 0)]);
  expect(fake.calls).toBe(1);
  expect((await service.detail(f.actor as never, f.account.id, preview.id)).items[0]!.status).toBe("released");
  expect(a.id).toBe(b.id);
});
it("hides previews and deletion from another owner", async () => {
  const f = await fixture(); const preview = await service.preview(f.actor as never, f.account.id);
  const stranger = { id: randomUUID(), role: "user" } as never;
  await expect(service.confirm(stranger, f.account.id, preview.id)).rejects.toMatchObject({ status: 404 });
  expect(fake.calls).toBe(0);
});
it("observes a lost response without releasing twice and blocks rotation during uncertainty", async () => {
  const f = await fixture(), preview = await service.preview(f.actor as never, f.account.id);
  await service.confirm(f.actor as never, f.account.id, preview.id);
  fake.release = () => ({ status: "pending", reason: "temporary_cloud_error" });
  expect((await service.execute(f.actor as never, f.account.id, preview.id, 0)).items[0]!.status).toBe("pending");
  const blocked = await connection.db.transaction(tx => reserveCloudRotationWrite(tx, { accountId: f.account.id, service: "lightsail", region: "ap-northeast-1", stepId: randomUUID(), action: "lightsail.static-ip.release" }));
  expect(blocked).toMatchObject({ allowed: false, ruleId: "idle_ip_cleanup" });
  await connection.client`update cloud_idle_ip_cleanups set items=jsonb_set(items,'{0,retryAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) where id=${preview.id}`;
  expect((await service.execute(f.actor as never, f.account.id, preview.id, 0)).items[0]!.status).toBe("released");
  expect(fake.calls).toBe(1);
});
it("rejects expired previews and account region changes before writes", async () => {
  const f = await fixture(), preview = await service.preview(f.actor as never, f.account.id);
  await connection.db.update(cloudIdleIpCleanups).set({ expiresAt: new Date(0) }).where(eq(cloudIdleIpCleanups.id, preview.id));
  await expect(service.confirm(f.actor as never, f.account.id, preview.id)).rejects.toMatchObject({ status: 409 });
  const fresh = await service.preview(f.actor as never, f.account.id);
  await service.confirm(f.actor as never, f.account.id, fresh.id);
  await connection.db.update(cloudAccounts).set({ regions: ["ap-southeast-1"] }).where(eq(cloudAccounts.id, f.account.id));
  await expect(service.execute(f.actor as never, f.account.id, fresh.id, 0)).rejects.toMatchObject({ status: 409 });
  expect(fake.calls).toBe(0);
});
it("releases a cloud-idle IP despite managed DNS created after confirmation", async () => {
  const f = await fixture(), preview = await service.preview(f.actor as never, f.account.id);
  await service.confirm(f.actor as never, f.account.id, preview.id);
  const [provider] = await connection.client`insert into provider_accounts(owner_user_id,provider,name,credential_ciphertext,credential_iv,credential_tag) values (${f.actor.id},'cloudflare','dns','x','x','x') returning id`;
  const [zone] = await connection.client`insert into zones(provider_account_id,external_id,name_ascii) values (${provider!.id},'zone','test.example') returning id`;
  const [pool] = await connection.client`insert into endpoint_pools(owner_user_id,name,strategy) values (${f.actor.id},'pool','primary_backup') returning id`;
  await connection.client`insert into dns_records(zone_id,external_id,type,name,content,ttl,management,remote_hash,managed_by_pool_id) values (${zone!.id},'record','A','test.example','203.0.113.9',60,'managed','hash',${pool!.id})`;
  expect((await service.execute(f.actor as never, f.account.id, preview.id, 0)).items[0]).toMatchObject({ status: "released" });
  expect(fake.calls).toBe(1);
});
it("records explicit release rejection as a failure instead of a permanent pending lock", async () => {
  const f = await fixture(), preview = await service.preview(f.actor as never, f.account.id);
  await service.confirm(f.actor as never, f.account.id, preview.id);
  fake.release = () => ({ status: "pending", reason: "permission_denied", rejectedNoEffect: true });
  expect((await service.execute(f.actor as never, f.account.id, preview.id, 0)).items[0]).toMatchObject({ status: "failed", reason: "permission_denied" });
  expect(await connection.db.transaction(tx => reserveCloudRotationWrite(tx, { accountId: f.account.id, service: "lightsail", region: "ap-northeast-1", stepId: randomUUID(), action: "lightsail.static-ip.release" }))).toMatchObject({ allowed: true });
});
it("pre-release read failure does not leave a mutation exclusion", async () => {
  const f = await fixture(), preview = await service.preview(f.actor as never, f.account.id);
  await service.confirm(f.actor as never, f.account.id, preview.id);
  fake.release = () => { throw new CloudError("temporary_cloud_error", true); };
  expect((await service.execute(f.actor as never, f.account.id, preview.id, 0)).items[0]).toMatchObject({ status: "failed", reason: "temporary_cloud_error" });
  expect(await connection.db.transaction(tx => reserveCloudRotationWrite(tx, { accountId: f.account.id, service: "lightsail", region: "ap-northeast-1", stepId: randomUUID(), action: "lightsail.static-ip.release" }))).toMatchObject({ allowed: true });
});
it("keeps old unresolved previews reachable and permits read-only confirmation on a disabled account", async () => {
  const f = await fixture(), preview = await service.preview(f.actor as never, f.account.id);
  await service.confirm(f.actor as never, f.account.id, preview.id);
  fake.release = () => ({ status: "pending", reason: "release_pending" });
  await service.execute(f.actor as never, f.account.id, preview.id, 0);
  for (let n = 0; n < 21; n++) await service.preview(f.actor as never, f.account.id);
  expect((await service.list(f.actor as never, f.account.id)).map(row => row.id)).toContain(preview.id);
  await connection.db.update(cloudAccounts).set({ enabled: false }).where(eq(cloudAccounts.id, f.account.id));
  await connection.client`update cloud_idle_ip_cleanups set items=jsonb_set(items,'{0,retryAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) where id=${preview.id}`;
  expect((await service.execute(f.actor as never, f.account.id, preview.id, 0)).items[0]!.status).toBe("released");
  expect(fake.calls).toBe(1);
});
it("serializes a concurrent DNS claim before allowing address deletion", async () => {
  const f = await fixture(), preview = await service.preview(f.actor as never, f.account.id);
  await service.confirm(f.actor as never, f.account.id, preview.id);
  let unlock!: () => void, locked!: () => void;
  const barrier = new Promise<void>(resolve => { unlock = resolve; });
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const dnsClaim = connection.db.transaction(async tx => {
    expect(await idleIpAddressReleasing(tx, "203.0.113.9")).toBe(false);
    locked(); await barrier;
  });
  await ready;
  const release = service.execute(f.actor as never, f.account.id, preview.id, 0);
  try {
    await vi.waitFor(async () => {
      const waiting = await connection.client`select 1 from pg_stat_activity where datname=${name} and wait_event='advisory' and query like '%824715%'`;
      expect(waiting.length).toBeGreaterThan(0);
    });
    expect(fake.calls).toBe(0);
  } finally { unlock(); await dnsClaim; }
  await release;
  expect(fake.calls).toBe(1);
});
it("ignores an observation from an older dispatch generation", async () => {
  const f = await fixture(), preview = await service.preview(f.actor as never, f.account.id);
  await service.confirm(f.actor as never, f.account.id, preview.id);
  fake.release = () => ({ status: "pending", reason: "release_pending" });
  await service.execute(f.actor as never, f.account.id, preview.id, 0);
  await connection.client`update cloud_idle_ip_cleanups set items=jsonb_set(items,'{0,retryAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) where id=${preview.id}`;
  let observed!: () => void, finish!: (value: any) => void;
  const started = new Promise<void>(resolve => { observed = resolve; });
  fake.observe = () => { observed(); return new Promise(resolve => { finish = resolve; }); };
  const late = service.execute(f.actor as never, f.account.id, preview.id, 0);
  await started;
  const newerId = randomUUID();
  await connection.client`update cloud_idle_ip_cleanups set items=jsonb_set(items,'{0,dispatchId}',to_jsonb(${newerId}::text)) where id=${preview.id}`;
  finish({ status: "skipped", reason: "attached" }); await late;
  expect((await service.detail(f.actor as never, f.account.id, preview.id)).items[0]).toMatchObject({ status: "pending", dispatchId: newerId });
});
it("honors vendor Retry-After even with local quota limits disabled", async () => {
  const f = await fixture(), preview = await service.preview(f.actor as never, f.account.id);
  await service.confirm(f.actor as never, f.account.id, preview.id);
  fake.release = () => ({ status: "pending", reason: "rate_limited", rejectedNoEffect: true, retryAfterMs: 180000 });
  const start = Date.now();
  const item = (await service.execute(f.actor as never, f.account.id, preview.id, 0)).items[0]!;
  expect(item.status).toBe("waiting");
  expect(Date.parse(item.retryAt!)).toBeGreaterThanOrEqual(start + 180000);
});

it("keeps a terminated unresolved release protected while allowing unrelated idle IPs", async () => {
  const f = await fixture(), rotation = await unresolvedRotation(f, "lightsail.static-ip.release");
  fake.items.push(rotation.original);
  const preview = await service.preview(f.actor as never, f.account.id);
  expect(preview.items.find(item => item.name === rotation.original.name)).toMatchObject({ status: "skipped", reason: "rotation_in_progress" });
  const unrelatedIndex = preview.items.findIndex(item => item.address === "203.0.113.9");
  expect(preview.items[unrelatedIndex]).toMatchObject({ status: "ready" });
  await service.confirm(f.actor as never, f.account.id, preview.id);
  expect((await service.execute(f.actor as never, f.account.id, preview.id, unrelatedIndex)).items[unrelatedIndex]).toMatchObject({ status: "released" });
  expect(fake.calls).toBe(1);
});

it("protects an uncertain allocation by its planned name before a receipt is persisted", async () => {
  const f = await fixture(), rotation = await unresolvedRotation(f, "lightsail.static-ip.allocate");
  fake.items.push({ ...fake.items[0], name: `masterdns-${rotation.attemptId}`, address: "203.0.113.10", arn: "arn:aws:lightsail:ap-northeast-1:123456789012:StaticIp/candidate" });
  const preview = await service.preview(f.actor as never, f.account.id);
  expect(preview.items.find(item => item.name === `masterdns-${rotation.attemptId}`)).toMatchObject({ status: "skipped", reason: "rotation_in_progress" });
  expect(preview.items.find(item => item.address === "203.0.113.9")).toMatchObject({ status: "ready" });
});

it("rechecks matching unresolved rotation evidence that appears after confirmation", async () => {
  const f = await fixture(); fake.items[0].address = "203.0.113.8";
  const preview = await service.preview(f.actor as never, f.account.id);
  await service.confirm(f.actor as never, f.account.id, preview.id);
  await unresolvedRotation(f, "lightsail.static-ip.release");
  expect((await service.execute(f.actor as never, f.account.id, preview.id, 0)).items[0]).toMatchObject({ status: "skipped", reason: "rotation_in_progress" });
  expect(fake.calls).toBe(0);
});

it("does not block an unrelated idle IP when an unresolved plan is malformed", async () => {
  const f = await fixture(), rotation = await unresolvedRotation(f, "lightsail.static-ip.release");
  await connection.db.update(rotationSteps).set({ plan: { ...rotation.plan, arguments: {} } }).where(eq(rotationSteps.id, rotation.plan.id));
  expect((await service.preview(f.actor as never, f.account.id)).items[0]).toMatchObject({ status: "ready" });
});
it("protects a precisely identified candidate when its unresolved plan is malformed", async () => {
  const f = await fixture(), rotation = await unresolvedRotation(f, "lightsail.static-ip.allocate");
  const candidate = { ...fake.items[0], name: `masterdns-${rotation.attemptId}`, address: "203.0.113.10", arn: "arn:aws:lightsail:ap-northeast-1:123456789012:StaticIp/candidate" };
  fake.items.push(candidate);
  await connection.db.insert(rotationResources).values({ incidentId: rotation.incident.id, attemptId: rotation.attemptId,
    address: candidate.address, allocationId: candidate.name, resourceId: candidate.arn, origin: "system", role: "candidate", snapshot: {} });
  await connection.db.update(rotationSteps).set({ plan: { ...rotation.plan, action: "unknown" as never, arguments: {} } }).where(eq(rotationSteps.id, rotation.plan.id));
  const preview = await service.preview(f.actor as never, f.account.id);
  expect(preview.items.find(item => item.name === candidate.name)).toMatchObject({ status: "skipped", reason: "rotation_in_progress" });
  expect(preview.items.find(item => item.address === "203.0.113.9")).toMatchObject({ status: "ready" });
});

it("does not block unrelated static IPs for terminated unresolved IPv6 steps", async () => {
  const f = await fixture(); await unresolvedRotation(f, "lightsail.ipv6.enable");
  expect((await service.preview(f.actor as never, f.account.id)).items[0]).toMatchObject({ status: "ready" });
});

it("protects an active candidate but not its original without unresolved steps", async () => {
  const f = await fixture(), rotation = await unresolvedRotation(f, "lightsail.static-ip.attach", true);
  await connection.db.update(rotationLeases).set({ unresolvedStepId: null }).where(eq(rotationLeases.physicalKey, rotation.physicalKey));
  await connection.db.insert(rotationResources).values({ incidentId: rotation.incident.id, attemptId: rotation.attemptId, address: fake.items[0].address, allocationId: fake.items[0].name, resourceId: fake.items[0].arn, origin: "system", role: "candidate", snapshot: {} });
  fake.items.push(rotation.original);
  const preview = await service.preview(f.actor as never, f.account.id);
  expect(preview.items.find(item => item.name === fake.items[0].name)).toMatchObject({ status: "skipped", reason: "rotation_in_progress" });
  expect(preview.items.find(item => item.name === rotation.original.name)).toMatchObject({ status: "ready" });
});
