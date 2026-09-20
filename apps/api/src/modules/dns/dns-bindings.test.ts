import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Redis } from "ioredis";
import { withDnsZoneLock } from "@masterdns/automation";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { addressHealthPolicies, addressHealthStates, bindingAssignments, cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, cloudScanScopes, createDatabase, dnsRecords, domainBindings, endpointPools, healthCheckConfigs, instanceAuthorizations, managedAddressSlots, operations, operationSteps, probeGroups, providerAccounts, rotationPublications, users, zones } from "@masterdns/db";
import type { AuthUser } from "../../auth/auth.types.js";
vi.mock("../../config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { CloudBindingsService } from "../cloud/cloud-bindings.service.js";
import { PoolsService } from "../pools/pools.service.js";
import { DnsService } from "./dns.service.js";

const databaseName = `dns_bindings_${randomUUID().replaceAll("-", "")}`;
let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
let redis: Redis;
let dns: DnsService;
let bindings: CloudBindingsService;
let pools: PoolsService;
const enqueue = vi.fn();
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  admin = createDatabase(root);
  await admin.client.unsafe(`create database "${databaseName}"`);
  const url = new URL(root); url.pathname = `/${databaseName}`;
  connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../../packages/db/drizzle", import.meta.url).pathname });
  redis = new Redis(process.env.MASTERDNS_TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  await redis.ping();
  const queues = { withDnsZoneLock: (zoneId: string, action: Parameters<typeof withDnsZoneLock>[2]) => withDnsZoneLock(redis, zoneId, action), operations: { add: enqueue } };
  dns = new DnsService({ db: connection.db } as never, queues as never, {} as never);
  bindings = new CloudBindingsService({ db: connection.db } as never, queues as never);
  pools = new PoolsService({ db: connection.db } as never, queues as never);
}, 30_000);
afterAll(async () => {
  await redis?.quit();
  await connection?.close();
  if (admin) { await admin.client.unsafe(`drop database if exists "${databaseName}"`); await admin.close(); }
});

async function fixture() {
  const [user] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const actor = { id: user!.id, role: "user" } as AuthUser;
  const credentials = { credentialCiphertext: "cipher", credentialIv: "iv", credentialTag: "tag" };
  const [account] = await connection.db.insert(cloudAccounts).values({ ownerUserId: actor.id, provider: "aws", name: "AWS production", externalAccountId: "123456789012", ...credentials }).returning();
  await connection.db.insert(cloudScanScopes).values({ accountId: account!.id, service: "ec2", region: "us-east-1", generation: 1 });
  const [instance] = await connection.db.insert(cloudInstances).values({ accountId: account!.id, service: "ec2", region: "us-east-1", externalId: "i-edge", name: "Edge server", scanGeneration: 1 }).returning();
  await connection.db.insert(instanceAuthorizations).values({ instanceId: instance!.id, managed: true });
  const [iface] = await connection.db.insert(cloudInterfaces).values({ instanceId: instance!.id, externalId: "eni-edge", scanGeneration: 1 }).returning();
  const [address] = await connection.db.insert(cloudAddresses).values({ interfaceId: iface!.id, kind: "host", family: "4", address: "192.0.2.20", origin: "user", scanGeneration: 1 }).returning();
  const [slot] = await connection.db.insert(managedAddressSlots).values({ interfaceId: iface!.id, family: "4", name: "primary", currentAddressId: address!.id }).returning();
  const [provider] = await connection.db.insert(providerAccounts).values({ ownerUserId: actor.id, provider: "cloudflare", name: "DNS", ...credentials }).returning();
  const [zone] = await connection.db.insert(zones).values({ providerAccountId: provider!.id, externalId: randomUUID(), nameAscii: "example.com", status: "active" }).returning();
  const input = { slotId: slot!.id, zoneId: zone!.id, fqdn: "pending.example.com", recordType: "A" as const, takeoverExisting: false };
  const bound = await bindings.bind(actor, input, randomUUID());
  return { actor, zone: zone!, provider: provider!, slot: slot!, address: address!, input, ...bound };
}

it("lists unverified bindings without inventing published DNS records and labels the cloud source", async () => {
  const f = await fixture();
  expect(await dns.listRecords(f.actor, f.zone.id)).toEqual([]);
  expect(await dns.listBindings(f.actor, f.zone.id)).toMatchObject([{
    id: f.binding.id, poolId: f.pool.id, published: false, inProgress: false,
    waitingReason: "需要为云地址配置外部 Agent 健康策略",
    cloudSources: [{ account: { name: "AWS production" }, instance: { name: "Edge server" }, currentAddress: { address: "192.0.2.20" } }],
  }]);
});

it("rejects cross-owner reads while allowing administrators to see the zone owner's bindings", async () => {
  const f = await fixture();
  await expect(dns.listBindings({ ...f.actor, id: randomUUID() }, f.zone.id)).rejects.toMatchObject({ status: 404 });
  expect(await dns.listBindings({ ...f.actor, id: randomUUID(), role: "admin" }, f.zone.id)).toHaveLength(1);
});

it("keeps a duplicate claim visible and releases the name when the unverified binding is cancelled", async () => {
  const f = await fixture();
  await expect(bindings.bind(f.actor, f.input, randomUUID())).rejects.toMatchObject({ status: 409 });
  expect(await dns.listBindings(f.actor, f.zone.id)).toHaveLength(1);
  const revision = f.pool.policyRevision;
  enqueue.mockClear();
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).resolves.toEqual({ deleted: true });
  expect(await dns.listBindings(f.actor, f.zone.id)).toEqual([]);
  expect(enqueue).not.toHaveBeenCalled();
  const [pool] = await connection.db.select().from(endpointPools).where(eq(endpointPools.id, f.pool.id));
  expect(pool!.policyRevision).toBe(revision + 1);
  await expect(bindings.bind(f.actor, f.input, randomUUID())).resolves.toMatchObject({ binding: { fqdn: f.input.fqdn } });
});

it.each(["pending", "running"] as const)("refuses cancellation during a %s DNS write and retains the binding", async status => {
  const f = await fixture();
  const [operation] = await connection.db.insert(operations).values({ ownerUserId: f.actor.id, actorUserId: f.actor.id, source: "user", idempotencyKey: randomUUID(), resourceType: "endpoint_pool", resourceId: f.pool.id }).returning();
  await connection.db.insert(operationSteps).values({ operationId: operation!.id, sequence: 1, providerAccountId: f.provider.id, zoneId: f.zone.id, action: "create", status, input: { bindingId: f.binding.id } });
  expect(await dns.listBindings(f.actor, f.zone.id)).toMatchObject([{ inProgress: true }]);
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id)).rejects.toMatchObject({ status: 409 });
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
});

it.each([["failed", "create"], ["skipped", "create"], ["failed", "update"], ["skipped", "update"]] as const)("retains a binding after an attempted %s %s without a local assignment", async (status, action) => {
  const f = await fixture();
  const [operation] = await connection.db.insert(operations).values({ ownerUserId: f.actor.id, actorUserId: f.actor.id, source: "user", idempotencyKey: randomUUID(), resourceType: "endpoint_pool", resourceId: f.pool.id }).returning();
  await connection.db.insert(operationSteps).values({ operationId: operation!.id, sequence: 1, providerAccountId: f.provider.id, zoneId: f.zone.id, action, status, attempts: 5, input: { bindingId: f.binding.id } });
  expect(await dns.listRecords(f.actor, f.zone.id)).toEqual([]);
  for (const unpublishedOnly of [true, false]) {
    await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id, unpublishedOnly)).rejects.toMatchObject({ status: 409 });
  }
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
  expect(await dns.listBindings(f.actor, f.zone.id)).toMatchObject([{ cancellationBlocked: true, waitingReason: "DNS 写入结果尚未确认，请先恢复或核对失败的 DNS 操作" }]);
});

it("allows cancelling an unexecuted skipped create", async () => {
  const f = await fixture();
  const [operation] = await connection.db.insert(operations).values({ ownerUserId: f.actor.id, actorUserId: f.actor.id, source: "user", idempotencyKey: randomUUID(), resourceType: "endpoint_pool", resourceId: f.pool.id }).returning();
  await connection.db.insert(operationSteps).values({ operationId: operation!.id, sequence: 1, providerAccountId: f.provider.id, zoneId: f.zone.id, action: "create", status: "skipped", attempts: 0, input: { bindingId: f.binding.id } });
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id, true)).resolves.toEqual({ deleted: true });
});

it("refuses an unpublished-only cancellation when publication completed after the page was loaded", async () => {
  const f = await fixture();
  const [record] = await connection.db.insert(dnsRecords).values({ zoneId: f.zone.id, externalId: "remote-record", type: "A", name: f.binding.fqdn, content: f.address.address, ttl: 60, remoteHash: "test", management: "managed", managedByPoolId: f.pool.id }).returning();
  await connection.db.insert(bindingAssignments).values({ domainBindingId: f.binding.id, endpointId: f.endpoint.id, dnsRecordId: record!.id, desired: true, applied: true, reason: "published" });
  enqueue.mockClear();
  await expect(pools.deleteBinding(f.actor, f.pool.id, f.binding.id, true)).rejects.toMatchObject({ status: 409 });
  expect(await dns.listBindings(f.actor, f.zone.id)).toMatchObject([{ published: true }]);
  expect(enqueue).not.toHaveBeenCalled();
  const deletion = await pools.deleteBinding(f.actor, f.pool.id, f.binding.id);
  expect(deletion).toHaveProperty("id");
  expect(enqueue).toHaveBeenCalledOnce();
  const steps = await connection.db.select().from(operationSteps).where(eq(operationSteps.zoneId, f.zone.id));
  expect(steps).toMatchObject([{ action: "delete", input: { bindingId: f.binding.id, deleteBinding: true } }]);
});

it("rolls back cancellation and its policy revision when the audit transaction fails", async () => {
  const f = await fixture();
  await expect(pools.deleteBinding({ id: randomUUID(), role: "admin" } as AuthUser, f.pool.id, f.binding.id, true)).rejects.toThrow();
  expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.id, f.binding.id))).toHaveLength(1);
  const [pool] = await connection.db.select().from(endpointPools).where(eq(endpointPools.id, f.pool.id));
  expect(pool!.policyRevision).toBe(f.pool.policyRevision);
});

it.each(["addressId", "addressVersion", "policyId", "policyRevision", "configId", "configVersion", "groupRevision", "expired"])("does not label stale %s evidence as a current external success", async mismatch => {
  const f = await fixture();
  const [config] = await connection.db.insert(healthCheckConfigs).values({ slotId: f.slot.id, checkerType: "tcp", config: { type: "tcp", port: 443, timeoutMs: 1000 } }).returning();
  const [group] = await connection.db.insert(probeGroups).values({ ownerUserId: f.actor.id, name: "External probes" }).returning();
  const [policy] = await connection.db.insert(addressHealthPolicies).values({ slotId: f.slot.id, family: "4", configId: config!.id, groupId: group!.id }).returning();
  await connection.db.update(managedAddressSlots).set({ currentVersion: 2 }).where(eq(managedAddressSlots.id, f.slot.id));
  const [state] = await connection.db.insert(addressHealthStates).values({ slotId: f.slot.id, family: "4", addressId: f.address.id, addressVersion: 2, configId: config!.id, configVersion: 1, policyId: policy!.id, policyRevision: 1, groupRevision: 1, healthState: "healthy", latestDecision: "success", consecutiveSuccesses: 3, evidenceExpiresAt: new Date(Date.now() + 60_000) }).returning();
  await connection.db.insert(rotationPublications).values({ slotId: f.slot.id, addressId: f.address.id, addressVersion: 1, errorCode: "historical_error" });
  expect(await dns.listBindings(f.actor, f.zone.id)).toMatchObject([{ waitingReason: "已收到外部成功结果，等待云地址确认及 DNS 发布" }]);
  const change = mismatch === "expired" ? { evidenceExpiresAt: new Date(0) } : { [mismatch]: mismatch.endsWith("Id") ? randomUUID() : 99 };
  await connection.db.update(addressHealthStates).set(change).where(eq(addressHealthStates.id, state!.id));
  expect(await dns.listBindings(f.actor, f.zone.id)).toMatchObject([{ waitingReason: "等待外部 Agent 对当前地址完成连续成功验证" }]);
});
