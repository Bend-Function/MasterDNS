import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, users, cloudAccounts, cloudIdleIpCleanups, setCloudRotationLimitPolicy, reserveCloudRotationWrite, idleIpAddressReleasing } from "@masterdns/db";
import { CloudError } from "@masterdns/cloud-providers";
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
it("rechecks managed DNS created after confirmation and skips deletion", async () => {
  const f = await fixture(), preview = await service.preview(f.actor as never, f.account.id);
  await service.confirm(f.actor as never, f.account.id, preview.id);
  const [provider] = await connection.client`insert into provider_accounts(owner_user_id,provider,name,credential_ciphertext,credential_iv,credential_tag) values (${f.actor.id},'cloudflare','dns','x','x','x') returning id`;
  const [zone] = await connection.client`insert into zones(provider_account_id,external_id,name_ascii) values (${provider!.id},'zone','test.example') returning id`;
  const [pool] = await connection.client`insert into endpoint_pools(owner_user_id,name,strategy) values (${f.actor.id},'pool','primary_backup') returning id`;
  await connection.client`insert into dns_records(zone_id,external_id,type,name,content,ttl,management,remote_hash,managed_by_pool_id) values (${zone!.id},'record','A','test.example','203.0.113.9',60,'managed','hash',${pool!.id})`;
  expect((await service.execute(f.actor as never, f.account.id, preview.id, 0)).items[0]).toMatchObject({ status: "skipped", reason: "managed_dns_reference" });
  expect(fake.calls).toBe(0);
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
