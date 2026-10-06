import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Redis } from "ioredis";
import { withDnsZoneLock } from "@masterdns/automation";
import { encryptJson } from "@masterdns/crypto";
import { CloudflareDnsAdapter } from "@masterdns/providers";
import { ProviderError, type ProviderRecord } from "@masterdns/contracts";
import { bindingAssignments, createDatabase, dnsRecords, domainBindings, endpointPools, endpoints, operations, operationSteps, providerAccounts, users, zones } from "@masterdns/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { AuthUser } from "../../auth/auth.types.js";
vi.mock("../../config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" } }));
import { PoolsService } from "./pools.service.js";

const databaseName = `binding_readback_${randomUUID().replaceAll("-", "")}`;
let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
let redis: Redis;
let pools: PoolsService;
const remote = new Map<string, ProviderRecord[]>();
const listRecords = vi.spyOn(CloudflareDnsAdapter.prototype, "listRecords").mockImplementation(async zone => ({ items: remote.get(zone) ?? [] }));
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL!;
  admin = createDatabase(root);
  await admin.client.unsafe(`create database "${databaseName}"`);
  const url = new URL(root); url.pathname = `/${databaseName}`;
  connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../../packages/db/drizzle", import.meta.url).pathname });
  redis = new Redis(process.env.MASTERDNS_TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  await redis.ping();
  pools = new PoolsService({ db: connection.db } as never, {
    withDnsZoneLock: (zoneId: string, action: Parameters<typeof withDnsZoneLock>[2]) => withDnsZoneLock(redis, zoneId, action),
    operations: { add: async () => undefined },
  } as never);
}, 30_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await redis?.quit();
  await connection?.close();
  if (admin) { await admin.client.unsafe(`drop database if exists "${databaseName}"`); await admin.close(); }
});

async function fixture(ttl = 60) {
  const [user] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const actor = { id: user!.id, role: "user" } as AuthUser;
  const encrypted = encryptJson({ provider: "cloudflare", apiToken: "readback-test" }, Buffer.alloc(32));
  const [account] = await connection.db.insert(providerAccounts).values({ ownerUserId: actor.id, provider: "cloudflare", name: "DNS", credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag }).returning();
  const [zone] = await connection.db.insert(zones).values({ providerAccountId: account!.id, externalId: randomUUID(), nameAscii: "example.com" }).returning();
  const [pool] = await connection.db.insert(endpointPools).values({ ownerUserId: actor.id, name: "Pool", strategy: "primary_backup" }).returning();
  const [endpoint] = await connection.db.insert(endpoints).values({ poolId: pool!.id, name: "Origin" }).returning();
  const [binding] = await connection.db.insert(domainBindings).values({ poolId: pool!.id, zoneId: zone!.id, fqdn: "edge.example.com", recordType: "A", originalEndpointId: endpoint!.id, ttl }).returning();
  const record: ProviderRecord = { externalId: "remote-record", zoneExternalId: zone!.externalId, type: "A", name: "edge.example.com", content: "192.0.2.10", ttl, providerMetadata: {} };
  const [operation] = await connection.db.insert(operations).values({ ownerUserId: actor.id, actorUserId: actor.id, source: "user", idempotencyKey: randomUUID(), resourceType: "endpoint_pool", resourceId: pool!.id }).returning();
  const [step] = await connection.db.insert(operationSteps).values({ operationId: operation!.id, sequence: 1, providerAccountId: account!.id, zoneId: zone!.id, action: "create", status: "failed", attempts: 1, input: { poolId: pool!.id, bindingId: binding!.id, endpointId: endpoint!.id, management: "managed", zoneExternalId: zone!.externalId, record } }).returning();
  return { actor, account: account!, zone: zone!, pool: pool!, endpoint: endpoint!, binding: binding!, record, step: step! };
}

async function publish(f: Awaited<ReturnType<typeof fixture>>) {
  const [record] = await connection.db.insert(dnsRecords).values({ zoneId: f.zone.id, externalId: f.record.externalId, type: "A", name: f.record.name, content: f.record.content, ttl: f.record.ttl, remoteHash: "test", management: "managed", managedByPoolId: f.pool.id }).returning();
  await connection.db.insert(bindingAssignments).values({ domainBindingId: f.binding.id, endpointId: f.endpoint.id, dnsRecordId: record!.id, applied: true, desired: true, reason: "published" });
  remote.set(f.zone.externalId, [f.record]);
  return record!;
}

it("deletes a currently verified publication despite an older failed write", async () => {
  const f = await fixture();
  await connection.db.update(operationSteps).set({ input: { ...f.step.input, record: { ...f.record, content: "192.0.2.99" } } }).where(eq(operationSteps.id, f.step.id));
  await publish(f);
  const deletion = await pools.deleteBinding(f.actor, f.pool.id, f.binding.id);
  expect(deletion).toHaveProperty("id");
  const steps = await connection.db.select().from(operationSteps).where(eq(operationSteps.operationId, (deletion as { id: string }).id));
  expect(steps).toMatchObject([{ action: "delete", input: { recordExternalId: "remote-record", deleteBinding: true } }]);
  expect((await connection.db.select().from(operationSteps).where(eq(operationSteps.id, f.step.id)))[0]).toMatchObject({ status: "failed", attempts: 1 });
});

it("adopts a failed create that succeeded remotely and queues its deletion", async () => {
  const f = await fixture();
  remote.set(f.zone.externalId, [f.record]);
  const deletion = await pools.deleteBinding(f.actor, f.pool.id, f.binding.id);
  expect(deletion).toHaveProperty("id");
  const records = await connection.db.select().from(dnsRecords).where(eq(dnsRecords.zoneId, f.zone.id));
  expect(records).toMatchObject([{ externalId: "remote-record", management: "managed", managedByPoolId: f.pool.id }]);
  const steps = await connection.db.select().from(operationSteps).where(eq(operationSteps.operationId, (deletion as { id: string }).id));
  expect(steps).toMatchObject([{ dnsRecordId: records[0]!.id, action: "delete", input: { deleteBinding: true } }]);
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
});

it("removes an uncertain binding only after verifying the complete RRset is absent", async () => {
  const f = await fixture();
  const record = await publish(f);
  remote.set(f.zone.externalId, []);
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).resolves.toEqual({ deleted: true });
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(0);
  expect((await connection.db.select().from(dnsRecords).where(eq(dnsRecords.id, record.id)))[0]).toMatchObject({ management: "unmanaged", managedByPoolId: null, deletedAt: expect.any(Date) });
});

it("keeps unpublished cancellation from deleting a discovered remote publication", async () => {
  const f = await fixture();
  remote.set(f.zone.externalId, [f.record]);
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id, true)).rejects.toThrow("该绑定已完成发布");
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
  expect(await connection.db.select().from(dnsRecords).where(eq(dnsRecords.zoneId, f.zone.id))).toHaveLength(0);
});

it("fails closed on an unrelated record in the same RRset", async () => {
  const f = await fixture();
  remote.set(f.zone.externalId, [f.record, { ...f.record, externalId: "unrelated", content: "192.0.2.99" }]);
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ status: 409 });
  expect(await connection.db.select().from(dnsRecords).where(eq(dnsRecords.zoneId, f.zone.id))).toHaveLength(0);
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
});

it("does not trust a managed ID whose remote content changed outside the attempted write", async () => {
  const f = await fixture();
  const record = await publish(f);
  remote.set(f.zone.externalId, [{ ...f.record, content: "192.0.2.99" }]);
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ status: 409 });
  expect((await connection.db.select().from(dnsRecords).where(eq(dnsRecords.id, record.id)))[0]).toMatchObject({ content: "192.0.2.10", deletedAt: null });
});

it("accepts an exact failed update on its original managed ID", async () => {
  const f = await fixture();
  await publish(f);
  await connection.db.update(operationSteps).set({ action: "update", input: { ...f.step.input, recordExternalId: f.record.externalId, record: { ...f.record, content: "192.0.2.20" } } }).where(eq(operationSteps.id, f.step.id));
  remote.set(f.zone.externalId, [{ ...f.record, content: "192.0.2.20" }]);
  const deletion = await pools.deleteBinding(f.actor, f.pool.id, f.binding.id);
  expect(deletion).toHaveProperty("id");
  const steps = await connection.db.select().from(operationSteps).where(eq(operationSteps.operationId, (deletion as { id: string }).id));
  expect(steps).toMatchObject([{ action: "delete", input: { recordExternalId: "remote-record", record: { content: "192.0.2.20" } } }]);
});

it("reads every page before concluding the RRset is absent", async () => {
  const f = await fixture();
  listRecords.mockImplementationOnce(async () => ({ items: [], nextCursor: "page-2" }));
  listRecords.mockImplementationOnce(async (zone, cursor) => {
    expect(zone).toBe(f.zone.externalId);
    expect(cursor).toBe("page-2");
    return { items: [f.record] };
  });
  const deletion = await pools.deleteBinding(f.actor, f.pool.id, f.binding.id);
  expect(deletion).toHaveProperty("id");
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
});

it("rejects a conflicting RRset record on a later page", async () => {
  const f = await fixture();
  listRecords.mockResolvedValueOnce({ items: [f.record], nextCursor: "page-2" });
  listRecords.mockResolvedValueOnce({ items: [{ ...f.record, externalId: "other", content: "192.0.2.99" }] });
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ status: 409 });
  expect(await connection.db.select().from(dnsRecords).where(eq(dnsRecords.zoneId, f.zone.id))).toHaveLength(0);
});

it.each(["cycle", "duplicate", "foreign-zone"])("rejects incomplete %s provider pagination", async kind => {
  const f = await fixture();
  if (kind === "cycle") {
    listRecords.mockResolvedValueOnce({ items: [], nextCursor: "page-2" });
    listRecords.mockResolvedValueOnce({ items: [], nextCursor: "page-2" });
  } else if (kind === "duplicate") {
    listRecords.mockResolvedValueOnce({ items: [f.record], nextCursor: "page-2" });
    listRecords.mockResolvedValueOnce({ items: [f.record] });
  } else listRecords.mockResolvedValueOnce({ items: [{ ...f.record, zoneExternalId: "other-zone" }] });
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ status: 409 });
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
});

it("preserves the provider read error and leaves binding and inventory unchanged", async () => {
  const f = await fixture();
  const record = await publish(f);
  const error = new ProviderError("Cloudflare permission denied", "permission_denied", "cloudflare");
  listRecords.mockRejectedValueOnce(error);
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toBe(error);
  expect((await connection.db.select().from(dnsRecords).where(eq(dnsRecords.id, record.id)))[0]).toMatchObject({ management: "managed", deletedAt: null });
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
});

it.each(["pending", "running"] as const)("blocks %s writes before remote readback", async status => {
  const f = await fixture();
  await connection.db.update(operationSteps).set({ status }).where(eq(operationSteps.id, f.step.id));
  const before = listRecords.mock.calls.length;
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ status: 409 });
  expect(listRecords.mock.calls.length).toBe(before);
});

it.each(["disabled", "owner", "input"])("rejects unsupported %s ownership before provider reads", async kind => {
  const f = await fixture();
  if (kind === "disabled") await connection.db.update(providerAccounts).set({ status: "disabled" }).where(eq(providerAccounts.id, f.account.id));
  else if (kind === "owner") {
    const [user] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
    await connection.db.update(providerAccounts).set({ ownerUserId: user!.id }).where(eq(providerAccounts.id, f.account.id));
  } else await connection.db.update(operationSteps).set({ input: { ...f.step.input, zoneExternalId: "other-zone" } }).where(eq(operationSteps.id, f.step.id));
  const before = listRecords.mock.calls.length;
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ status: 409 });
  expect(listRecords.mock.calls.length).toBe(before);
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
});

it("rejects credentials rotated while the provider read was in progress", async () => {
  const f = await fixture();
  listRecords.mockImplementationOnce(async () => {
    const encrypted = encryptJson({ provider: "cloudflare", apiToken: "rotated-token" }, Buffer.alloc(32));
    await connection.db.update(providerAccounts).set({ credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag }).where(eq(providerAccounts.id, f.account.id));
    return { items: [f.record] };
  });
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ status: 409 });
  expect(await connection.db.select().from(dnsRecords).where(eq(dnsRecords.zoneId, f.zone.id))).toHaveLength(0);
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
});

it("rolls back readback when the Zone lease is lost during a slow provider read", async () => {
  const f = await fixture();
  const guarded = new PoolsService({ db: connection.db } as never, {
    withDnsZoneLock: (zoneId: string, action: Parameters<typeof withDnsZoneLock>[2]) => withDnsZoneLock(redis, zoneId, action, { leaseMs: 1_000, refreshIntervalMs: 20, commandTimeoutMs: 100 }),
    operations: { add: async () => undefined },
  } as never);
  listRecords.mockImplementationOnce(async () => {
    await redis.del(`masterdns:zone-lock:${f.zone.id}`);
    await new Promise(resolve => setTimeout(resolve, 60));
    return { items: [f.record] };
  });
  await expect(guarded.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ code: "lost" });
  expect(await connection.db.select().from(dnsRecords).where(eq(dnsRecords.zoneId, f.zone.id))).toHaveLength(0);
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
});

it("requires an errored provider account to be restored before authorizing deletion", async () => {
  const f = await fixture();
  await connection.db.update(providerAccounts).set({ status: "error" }).where(eq(providerAccounts.id, f.account.id));
  remote.set(f.zone.externalId, [f.record]);
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ status: 409 });
  expect(await connection.db.select().from(dnsRecords).where(eq(dnsRecords.zoneId, f.zone.id))).toHaveLength(0);
});

it("rejects malformed remote metadata before adoption or queueing", async () => {
  const f = await fixture();
  listRecords.mockResolvedValueOnce({ items: [{ ...f.record, providerMetadata: [] as unknown as Record<string, unknown> }] });
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ status: 409 });
  expect(await connection.db.select().from(dnsRecords).where(eq(dnsRecords.zoneId, f.zone.id))).toHaveLength(0);
});

it.each(["externalId", "name", "type"])("rejects a malformed remote %s instead of interpreting the binding as absent", async field => {
  const f = await fixture();
  listRecords.mockResolvedValueOnce({ items: [{ ...f.record, [field]: field === "externalId" ? 123 : "" } as ProviderRecord] });
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ status: 409 });
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
});

it.each(["credentialIv", "credentialTag", "credentialKeyVersion", "status", "zoneExternalId"] as const)("rejects %s changed during the remote read", async field => {
  const f = await fixture();
  listRecords.mockImplementationOnce(async () => {
    if (field === "zoneExternalId") await connection.db.update(zones).set({ externalId: "replacement-zone" }).where(eq(zones.id, f.zone.id));
    else await connection.db.update(providerAccounts).set({
      [field]: field === "credentialKeyVersion" ? 2 : field === "status" ? "disabled" : "replacement",
    }).where(eq(providerAccounts.id, f.account.id));
    return { items: [f.record] };
  });
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ status: 409 });
  expect(await connection.db.select().from(dnsRecords).where(eq(dnsRecords.zoneId, f.zone.id))).toHaveLength(0);
});

it.each(["create", "update"] as const)("adopts an exact failed %s with a valid two-day Pool TTL", async action => {
  const f = await fixture(172_800);
  if (action === "update") await connection.db.update(operationSteps).set({ action, input: { ...f.step.input, recordExternalId: f.record.externalId } }).where(eq(operationSteps.id, f.step.id));
  remote.set(f.zone.externalId, [f.record]);
  const deletion = await pools.deleteBinding(f.actor, f.pool.id, f.binding.id);
  expect(deletion).toHaveProperty("id");
  const records = await connection.db.select().from(dnsRecords).where(eq(dnsRecords.zoneId, f.zone.id));
  expect(records).toMatchObject([{ externalId: "remote-record", ttl: 172_800, management: "managed", managedByPoolId: f.pool.id }]);
  const steps = await connection.db.select().from(operationSteps).where(eq(operationSteps.operationId, (deletion as { id: string }).id));
  expect(steps).toMatchObject([{ action: "delete", input: { deleteBinding: true, record: { ttl: 172_800 } } }]);
});

it.each([
  ["create", "present"], ["update", "present"], ["create", "absent"], ["update", "absent"],
] as const)("resolves published two-day TTL inventory after a failed %s when the remote RRset is %s", async (action, state) => {
  const f = await fixture(172_800);
  if (action === "update") await connection.db.update(operationSteps).set({ action, input: { ...f.step.input, recordExternalId: f.record.externalId } }).where(eq(operationSteps.id, f.step.id));
  const record = await publish(f);
  if (state === "absent") remote.set(f.zone.externalId, []);
  const deletion = await pools.deleteBinding(f.actor, f.pool.id, f.binding.id);
  if (state === "present") {
    expect(deletion).toHaveProperty("id");
    const steps = await connection.db.select().from(operationSteps).where(eq(operationSteps.operationId, (deletion as { id: string }).id));
    expect(steps).toMatchObject([{ dnsRecordId: record.id, action: "delete", input: { record: { ttl: 172_800 } } }]);
  } else {
    expect(deletion).toEqual({ deleted: true });
    expect((await connection.db.select().from(dnsRecords).where(eq(dnsRecords.id, record.id)))[0]).toMatchObject({ ttl: 172_800, management: "unmanaged", deletedAt: expect.any(Date) });
  }
});

it("validates current managed two-day TTL inventory independently of an older normal TTL write", async () => {
  const f = await fixture(172_800);
  await connection.db.update(operationSteps).set({ input: { ...f.step.input, record: { ...f.record, ttl: 60 } } }).where(eq(operationSteps.id, f.step.id));
  const record = await publish(f);
  const deletion = await pools.deleteBinding(f.actor, f.pool.id, f.binding.id);
  expect(deletion).toHaveProperty("id");
  const steps = await connection.db.select().from(operationSteps).where(eq(operationSteps.operationId, (deletion as { id: string }).id));
  expect(steps).toMatchObject([{ dnsRecordId: record.id, action: "delete", input: { record: { ttl: 172_800 } } }]);
});

it("accepts the maximum persisted Pool TTL while retaining the exact remote match", async () => {
  const f = await fixture(2_147_483_647);
  remote.set(f.zone.externalId, [f.record]);
  expect(await pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).toHaveProperty("id");
  expect(await connection.db.select().from(dnsRecords).where(eq(dnsRecords.zoneId, f.zone.id))).toMatchObject([{ ttl: 2_147_483_647 }]);
});

it.each([0, 1.5, 2_147_483_648])("still blocks invalid persisted Pool TTL %s", async ttl => {
  const f = await fixture();
  await connection.db.update(operationSteps).set({ input: { ...f.step.input, record: { ...f.record, ttl } } }).where(eq(operationSteps.id, f.step.id));
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ status: 409 });
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
});

it("retains the DNS address refinement when widening persisted Pool TTL validation", async () => {
  const f = await fixture(172_800);
  await connection.db.update(operationSteps).set({ input: { ...f.step.input, record: { ...f.record, content: "not-an-ip" } } }).where(eq(operationSteps.id, f.step.id));
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ status: 409 });
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
});
