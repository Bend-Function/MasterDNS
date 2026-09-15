import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Redis } from "ioredis";
import { withDnsZoneLock } from "@masterdns/automation";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, cloudScanScopes, createDatabase, dnsRecords, domainBindings, endpointAddresses, endpointPools, instanceAuthorizations, managedAddressSlots, providerAccounts, users, zones } from "@masterdns/db";
import type { AuthUser } from "../../auth/auth.types.js";

vi.mock("@masterdns/cloud-providers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@masterdns/cloud-providers")>(),
  createCloudAdapter: ({ credentials }: { credentials: { accessKeyId?: string } }) => ({ verifyIdentity: async () => ({ externalAccountId: credentials.accessKeyId?.startsWith("other-") ? "999999999999" : "123456789012" }) }),
}));
vi.mock("../../config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { CloudService } from "./cloud.service.js";
import { CloudBindingsService } from "./cloud-bindings.service.js";
import { DnsService } from "../dns/dns.service.js";
import { OperationsService } from "../operations/operations.service.js";

const databaseName = `cloud_api_${randomUUID().replaceAll("-", "")}`;
let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
let service: CloudService;
let bindings: CloudBindingsService;
let redis: Redis;
const queue = { cloudSync: { add: vi.fn().mockResolvedValue({}) } };

beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  admin = createDatabase(root);
  await admin.client.unsafe(`create database "${databaseName}"`);
  const url = new URL(root); url.pathname = `/${databaseName}`;
  connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../../packages/db/drizzle", import.meta.url).pathname });
  service = new CloudService({ db: connection.db } as never, queue as never);
  redis = new Redis(process.env.MASTERDNS_TEST_REDIS_URL ?? "redis://127.0.0.1:56379", { maxRetriesPerRequest: null });
  await redis.ping();
  bindings = new CloudBindingsService({ db: connection.db } as never, { withDnsZoneLock: (zoneId: string, action: Parameters<typeof withDnsZoneLock>[2]) => withDnsZoneLock(redis, zoneId, action) } as never);
}, 30000);

afterAll(async () => {
  await redis?.quit();
  await connection?.close();
  if (admin) { await admin.client.unsafe(`drop database if exists "${databaseName}"`); await admin.close(); }
});

async function fixture() {
  const [owner] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const actor = { id: owner!.id, role: "user" } as AuthUser;
  const account = await service.create(actor, { name: "AWS", provider: "aws", credentials: { kind: "access_key", accessKeyId: "test-access-key", secretAccessKey: "test-secret-access-key" } });
  const [scope] = await connection.db.insert(cloudScanScopes).values({ accountId: account.id, service: "ec2", region: "us-east-1", generation: 1 }).returning();
  const [instance] = await connection.db.insert(cloudInstances).values({ accountId: account.id, service: "ec2", region: "us-east-1", externalId: "i-test", scanGeneration: 1 }).returning();
  const [iface] = await connection.db.insert(cloudInterfaces).values({ instanceId: instance!.id, externalId: "eni-test", scanGeneration: 1 }).returning();
  const [address] = await connection.db.insert(cloudAddresses).values({ interfaceId: iface!.id, kind: "host", family: "4", address: "192.0.2.10", origin: "user", scanGeneration: 1 }).returning();
  const [slot] = await connection.db.insert(managedAddressSlots).values({ interfaceId: iface!.id, family: "4", name: "primary", currentAddressId: address!.id }).returning();
  const [dnsAccount] = await connection.db.insert(providerAccounts).values({ ownerUserId: actor.id, provider: "cloudflare", name: "DNS", credentialCiphertext: "cipher", credentialIv: "iv", credentialTag: "tag" }).returning();
  const [zone] = await connection.db.insert(zones).values({ providerAccountId: dnsAccount!.id, externalId: randomUUID(), nameAscii: "example.com", status: "active" }).returning();
  return { actor, account, instance: instance!, iface: iface!, address: address!, slot: slot!, zone: zone!, scope: scope! };
}

describe("cloud account and authorization API", () => {
  it("filters accounts by owner and rejects cross-owner instance access", async () => {
    const a = await fixture(); const b = await fixture();
    expect((await service.list(a.actor)).map((row) => row.id)).toEqual([a.account.id]);
    await expect(service.instance(a.actor, b.instance.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.sync(a.actor, b.account.id)).rejects.toMatchObject({ status: 404 });
  });
  it("stores encrypted credentials and blocks deployment credentials for ordinary users", async () => {
    const { actor, account } = await fixture();
    expect(account).not.toHaveProperty("credentialCiphertext");
    const [stored] = await connection.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, account.id));
    expect(stored!.credentialCiphertext).not.toContain("test-secret-access-key");
    await expect(service.create(actor, { name: "ambient", provider: "aws", credentials: { kind: "role" } })).rejects.toMatchObject({ status: 403 });
    await expect(service.rotateCredentials(actor, account.id, { credentials: { kind: "role", roleArn: "arn:aws:iam::123456789012:role/test" } })).rejects.toMatchObject({ status: 403 });
  });
  it("pins AWS account identity and rejects credentials for a different AWS account", async () => {
    const f = await fixture();
    expect(f.account).toMatchObject({ externalAccountId: "123456789012" });
    await expect(service.rotateCredentials(f.actor, f.account.id, { credentials: { kind: "access_key", accessKeyId: "other-access-key", secretAccessKey: "other-secret-access-key" } })).rejects.toMatchObject({ status: 409 });
    const [stored] = await connection.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, f.account.id));
    expect(stored!.externalAccountId).toBe("123456789012");
  });
  it("reports capabilities for the exact selected address and keeps IAM permission unverified", async () => {
    const f = await fixture();
    await connection.db.update(cloudInterfaces).set({ metadata: { deviceIndex: 0, primaryAddresses: ["2001:db8::1"] } }).where(eq(cloudInterfaces.id, f.iface.id));
    const [secondary] = await connection.db.insert(cloudAddresses).values({ interfaceId: f.iface.id, kind: "host", family: "6", address: "2001:db8::2", origin: "user", scanGeneration: 1 }).returning();
    const [slot] = await connection.db.insert(managedAddressSlots).values({ interfaceId: f.iface.id, family: "6", name: "secondary", currentAddressId: secondary!.id }).returning();
    const selected = (await service.slots(f.actor, f.instance.id)).find((row) => row.slot.id === slot!.id);
    expect(selected).toMatchObject({ ref: { instanceId: "i-test", interfaceId: "eni-test", address: "2001:db8::2", family: 6 }, capability: { available: true, permission: "unverified" } });
  });
  it("persists regional restrictions and blocks excluded-region management and binding", async () => {
    const f = await fixture();
    const account = await service.setRegions(f.actor, f.account.id, ["ap-southeast-2"]);
    expect(account.regions).toEqual(["ap-southeast-2"]);
    expect((await service.instances(f.actor, f.account.id))[0]).toMatchObject({ inScope: false });
    await expect(service.authorize(f.actor, f.instance.id, { managed: true, revision: 0 })).rejects.toMatchObject({ status: 409 });
    await expect(bindings.bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false })).rejects.toMatchObject({ status: 409 });
  });
  it("allows management with all automatic actions disabled", async () => {
    const { actor, instance } = await fixture();
    expect(await service.authorize(actor, instance.id, { managed: true, revision: 0 })).toMatchObject({ managed: true, allowIpv4Rotation: false, allowIpv6Rotation: false, allowStopStart: false, allowReleaseAddress: false });
  });
  it("revokes every permission atomically with a new revision and rejects stale authorization", async () => {
    const { actor, instance } = await fixture();
    const authorized = await service.authorize(actor, instance.id, { managed: true, revision: 0, allowIpv4Rotation: true });
    expect(authorized).toMatchObject({ revision: 1, allowIpv4Rotation: true, allowStopStart: false });
    const revoked = await service.authorize(actor, instance.id, { managed: false, revision: 1 });
    expect(revoked).toMatchObject({ revision: 2, allowIpv4Rotation: false, allowIpv6Rotation: false, allowStopStart: false, allowReleaseAddress: false });
    await expect(service.authorize(actor, instance.id, { managed: true, revision: 1, allowIpv4Rotation: true })).rejects.toMatchObject({ status: 409 });
    expect(await connection.db.select().from(instanceAuthorizations).where(eq(instanceAuthorizations.instanceId, instance.id))).toHaveLength(1);
  });
  it("does not queue scans or allow new authorizations on disabled accounts", async () => {
    const { actor, account, instance } = await fixture();
    await service.setEnabled(actor, account.id, false);
    await expect(service.sync(actor, account.id)).rejects.toMatchObject({ status: 409 });
    await expect(service.authorize(actor, instance.id, { managed: true, revision: 0, allowIpv4Rotation: true })).rejects.toMatchObject({ status: 409 });
    expect(await service.authorize(actor, instance.id, { managed: false, revision: 0 })).toMatchObject({ revision: 1 });
  });
});

describe("cloud DNS binding", () => {
  it("creates a fresh linked cloud endpoint without publishing scanned addresses", async () => {
    const f = await fixture();
    const result = await bindings.bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false });
    expect(result.binding.fqdn).toBe("www.example.com");
    expect(result.endpoint.addressMode).toBe("cloud");
    expect(await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.endpointId, result.endpoint.id))).toEqual([]);
    await expect(bindings.bind(f.actor, { zoneId: f.zone.id, fqdn: "www.example.com.", recordType: "A", slotId: f.slot.id, takeoverExisting: false })).rejects.toMatchObject({ status: 409 });
    expect(await connection.db.select().from(endpointPools).where(eq(endpointPools.ownerUserId, f.actor.id))).toHaveLength(1);
  });
  it("rejects binding while an earlier DNS write for the same RRset is pending", async () => {
    const f = await fixture();
    const operations = new OperationsService({ db: connection.db } as never, { operations: { add: async () => ({}) } } as never);
    await operations.createDnsOperation({ ownerUserId: f.actor.id, actorUserId: f.actor.id, source: "user", idempotencyKey: randomUUID(), providerAccountId: f.zone.providerAccountId, zoneId: f.zone.id, zoneExternalId: f.zone.externalId, action: "create", record: { name: "www.example.com", type: "A", content: f.address.address, ttl: 60, providerMetadata: {} } });
    await expect(bindings.bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false })).rejects.toMatchObject({ status: 409 });
  });
  it("blocks generic DNS creation while an unverified cloud binding owns the name", async () => {
    const f = await fixture();
    await bindings.bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false });
    const dns = new DnsService({ db: connection.db } as never, {} as never, { createDnsOperation: async () => ({ created: true }) } as never);
    await expect(dns.createRecord(f.actor, f.zone.id, { name: "www", type: "A", content: "192.0.2.99", ttl: 60, providerMetadata: {} })).rejects.toMatchObject({ status: 409 });
  });
  it("rejects a new operation enqueued after the cloud claim", async () => {
    const f = await fixture();
    await bindings.bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false });
    const operations = new OperationsService({ db: connection.db } as never, { operations: { add: async () => ({}) } } as never);
    await expect(operations.createDnsOperation({ ownerUserId: f.actor.id, actorUserId: f.actor.id, source: "user", idempotencyKey: randomUUID(), providerAccountId: f.zone.providerAccountId, zoneId: f.zone.id, zoneExternalId: f.zone.externalId, action: "create", record: { name: "www.example.com", type: "A", content: f.address.address, ttl: 60, providerMetadata: {} } })).rejects.toMatchObject({ status: 409 });
  });
  it("serializes concurrent manual enqueue and cloud ownership claim", async () => {
    const f = await fixture();
    const operations = new OperationsService({ db: connection.db } as never, { operations: { add: async () => ({}) } } as never);
    const results = await Promise.allSettled([
      bindings.bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false }),
      operations.createDnsOperation({ ownerUserId: f.actor.id, actorUserId: f.actor.id, source: "user", idempotencyKey: randomUUID(), providerAccountId: f.zone.providerAccountId, zoneId: f.zone.id, zoneExternalId: f.zone.externalId, action: "create", record: { name: "www.example.com", type: "A", content: f.address.address, ttl: 60, providerMetadata: {} } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  });
  it("reuses an explicitly selected pool endpoint for the same slot", async () => {
    const f = await fixture();
    const first = await bindings.bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false });
    const second = await bindings.bind(f.actor, { zoneId: f.zone.id, fqdn: "other", recordType: "A", slotId: f.slot.id, poolId: first.pool.id, takeoverExisting: false });
    expect(second.endpoint.id).toBe(first.endpoint.id);
    expect(second.pool.id).toBe(first.pool.id);
  });
  it("keeps same-address takeover visible without declaring it externally verified", async () => {
    const f = await fixture();
    const [record] = await connection.db.insert(dnsRecords).values({ zoneId: f.zone.id, externalId: "record", type: "A", name: "www.example.com", content: f.address.address, ttl: 300, remoteHash: "existing" }).returning();
    const result = await bindings.bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: true });
    expect(result.binding.ttl).toBe(300);
    const [claimed] = await connection.db.select().from(dnsRecords).where(eq(dnsRecords.id, record!.id));
    expect(claimed).toMatchObject({ content: f.address.address, management: "managed", managedByPoolId: result.pool.id });
    expect(await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.endpointId, result.endpoint.id))).toEqual([]);
  });
  it("rejects takeover of a different address and cross-owner slots", async () => {
    const f = await fixture(); const other = await fixture();
    await connection.db.insert(dnsRecords).values({ zoneId: f.zone.id, externalId: "record", type: "A", name: "www.example.com", content: "192.0.2.99", ttl: 60, remoteHash: "existing" });
    await expect(bindings.bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: true })).rejects.toMatchObject({ status: 409 });
    await expect(bindings.bind(f.actor, { zoneId: f.zone.id, fqdn: "other", recordType: "A", slotId: other.slot.id, takeoverExisting: false })).rejects.toMatchObject({ status: 404 });
    expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.zoneId, f.zone.id))).toEqual([]);
  });
});
