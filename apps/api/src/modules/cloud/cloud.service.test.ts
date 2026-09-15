import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Redis } from "ioredis";
import { withDnsZoneLock } from "@masterdns/automation";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, cloudScanScopes, createDatabase, auditLogs, bindingAssignments, endpoints, dnsRecords, domainBindings, endpointAddresses, endpointPools, instanceAuthorizations, managedAddressSlots, providerAccounts, users, zones } from "@masterdns/db";
import type { AuthUser } from "../../auth/auth.types.js";

const identityHook = vi.hoisted(() => ({ run: undefined as (() => Promise<void>) | undefined }));
vi.mock("@masterdns/cloud-providers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@masterdns/cloud-providers")>(),
  evaluateCapabilities: vi.fn((await importOriginal<typeof import("@masterdns/cloud-providers")>()).evaluateCapabilities),
  createCloudAdapter: ({ credentials }: { credentials: { accessKeyId?: string; subscriptionId?: string; token?: string } }) => ({ verifyIdentity: async () => {
    if (credentials.accessKeyId === "rotated-access-key" || credentials.accessKeyId === "request-access-key") await identityHook.run?.();
    return { externalAccountId: credentials.subscriptionId ?? (credentials.token ? (credentials.token.startsWith("other-") ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") : credentials.accessKeyId?.startsWith("other-") ? "999999999999" : "123456789012") };
  } }),
}));
vi.mock("../../config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { evaluateCapabilities } from "@masterdns/cloud-providers";
import { CloudService } from "./cloud.service.js";
import { CloudController } from "./cloud.controller.js";
import { CloudBindingsService } from "./cloud-bindings.service.js";
import { DnsService } from "../dns/dns.service.js";
import { OperationsService } from "../operations/operations.service.js";

const databaseName = `cloud_api_${randomUUID().replaceAll("-", "")}`;
let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
let service: CloudService;
let bindings: CloudBindingsService;
let redis: Redis;
const create = (actor: AuthUser, input: Parameters<CloudService["create"]>[1], key = randomUUID()) => service.create(actor, input, key);
const bind = (actor: AuthUser, input: Parameters<CloudBindingsService["bind"]>[1], key = randomUUID()) => bindings.bind(actor, input, key);
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

async function fixture(managed = false) {
  const [owner] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const actor = { id: owner!.id, role: "user" } as AuthUser;
  const account = await create(actor, { name: "AWS", provider: "aws", credentials: { kind: "access_key", accessKeyId: "test-access-key", secretAccessKey: "test-secret-access-key" } });
  const [scope] = await connection.db.insert(cloudScanScopes).values({ accountId: account.id, service: "ec2", region: "us-east-1", generation: 1 }).returning();
  const [instance] = await connection.db.insert(cloudInstances).values({ accountId: account.id, service: "ec2", region: "us-east-1", externalId: "i-test", scanGeneration: 1 }).returning();
  const [iface] = await connection.db.insert(cloudInterfaces).values({ instanceId: instance!.id, externalId: "eni-test", scanGeneration: 1 }).returning();
  const [address] = await connection.db.insert(cloudAddresses).values({ interfaceId: iface!.id, kind: "host", family: "4", address: "192.0.2.10", origin: "user", scanGeneration: 1 }).returning();
  const [slot] = await connection.db.insert(managedAddressSlots).values({ interfaceId: iface!.id, family: "4", name: "primary", currentAddressId: address!.id }).returning();
  const [dnsAccount] = await connection.db.insert(providerAccounts).values({ ownerUserId: actor.id, provider: "cloudflare", name: "DNS", credentialCiphertext: "cipher", credentialIv: "iv", credentialTag: "tag" }).returning();
  const [zone] = await connection.db.insert(zones).values({ providerAccountId: dnsAccount!.id, externalId: randomUUID(), nameAscii: "example.com", status: "active" }).returning();
  if (managed) await service.authorize(actor, instance!.id, { managed: true, revision: 0 });
  return { actor, account, instance: instance!, iface: iface!, address: address!, slot: slot!, zone: zone!, scope: scope! };
}

describe("cloud account and authorization API", () => {
  it("encrypts provider credentials and keeps provider hints and audit payloads secret-free", async () => {
    const f = await fixture();
    const azure = { kind: "azure_service_principal" as const, tenantId: "11111111-1111-4111-8111-111111111111", subscriptionId: "22222222-2222-4222-8222-222222222222", clientId: "33333333-3333-4333-8333-333333333333", clientSecret: "azure-client-secret" };
    const azureAccount = await create(f.actor, { name: "Azure", provider: "azure", regions: ["australiaeast"], credentials: azure });
    const linodeAccount = await create(f.actor, { name: "Linode", provider: "linode", regions: ["ap-south"], credentials: { kind: "linode_token", token: "linode-secret-token" } });
    expect(azureAccount).toMatchObject({ provider: "azure", externalAccountId: azure.subscriptionId, credentialHint: "Service principal ...3333" });
    expect(linodeAccount).toMatchObject({ provider: "linode", externalAccountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", credentialHint: "Linode API token" });
    await expect(service.rotateCredentials(f.actor, azureAccount.id, { credentials: { ...azure, subscriptionId: "44444444-4444-4444-8444-444444444444" } })).rejects.toMatchObject({ status: 409 });
    await expect(service.rotateCredentials(f.actor, linodeAccount.id, { credentials: { kind: "linode_token", token: "other-linode-secret-token" } })).rejects.toMatchObject({ status: 409 });
    const stored = await connection.db.select().from(cloudAccounts).where(eq(cloudAccounts.ownerUserId, f.actor.id));
    const audit = await connection.db.select().from(auditLogs).where(eq(auditLogs.ownerUserId, f.actor.id));
    const serialized = JSON.stringify({ public: await service.list(f.actor), stored, audit });
    for (const secret of [azure.clientSecret, "linode-secret-token"]) expect(serialized).not.toContain(secret);
    expect(azureAccount).not.toHaveProperty("credentialCiphertext");
    expect(linodeAccount).not.toHaveProperty("credentialIv");
  });
  it("rejects cross-provider credential replacement and validates regions using saved provider", async () => {
    const f = await fixture();
    await expect(service.rotateCredentials(f.actor, f.account.id, { credentials: { kind: "linode_token", token: "secret-token" } })).rejects.toMatchObject({ status: 400 });
    await expect(service.setRegions(f.actor, f.account.id, ["australiaeast"])).rejects.toMatchObject({ status: 400 });
    await connection.db.update(cloudAccounts).set({ provider: "azure" }).where(eq(cloudAccounts.id, f.account.id));
    await expect(service.setRegions(f.actor, f.account.id, ["australiaeast"])).resolves.toMatchObject({ regions: ["australiaeast"] });
    await expect(service.setRegions(f.actor, f.account.id, ["us-east-1"])).rejects.toMatchObject({ status: 400 });
  });
  it("reconstructs exact normalized provider metadata and standard address fields for capability evaluation", async () => {
    const f = await fixture();
    const ipConfigurationId = "/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/" + "r".repeat(90) + "/providers/Microsoft.Network/networkInterfaces/" + "n".repeat(90) + "/ipConfigurations/exact-config";
    const instanceMetadata = { supported: true };
    const interfaceMetadata = { nicId: ipConfigurationId.split("/ipConfigurations/")[0], ipConfigurationId, supported: true };
    const addressMetadata = { supported: true, sku: { name: "Standard", tier: "Regional" }, zones: [], allocationMethod: "Static", ipConfigurationId };
    await connection.db.update(cloudInstances).set({ service: "azure_vm", region: "australiaeast", state: "running", metadata: { present: true, providerMetadata: instanceMetadata } }).where(eq(cloudInstances.id, f.instance.id));
    await connection.db.update(cloudInterfaces).set({ externalId: ipConfigurationId, metadata: { primaryAddresses: [f.address.address], providerMetadata: interfaceMetadata } }).where(eq(cloudInterfaces.id, f.iface.id));
    await connection.db.update(cloudAddresses).set({ remoteAllocationId: ipConfigurationId + "/allocation", metadata: { providerMetadata: addressMetadata, privateAddress: "10.0.0.4", resourceId: ipConfigurationId + "/resource" } }).where(eq(cloudAddresses.id, f.address.id));
    const slots = await service.slots(f.actor, f.instance.id);
    expect(slots[0]!.capability).toMatchObject({ available: true, requiresStop: false });
    expect(vi.mocked(evaluateCapabilities).mock.lastCall?.[1]).toMatchObject({ metadata: instanceMetadata, interfaces: [{ id: ipConfigurationId, metadata: interfaceMetadata, addresses: [{ metadata: addressMetadata, privateAddress: "10.0.0.4", resourceId: ipConfigurationId + "/resource", allocationId: ipConfigurationId + "/allocation" }] }] });
    expect(JSON.stringify(await service.list(f.actor))).not.toContain("test-secret-access-key");
  });
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
    await expect(create(actor, { name: "ambient", provider: "aws", credentials: { kind: "role" } })).rejects.toMatchObject({ status: 403 });
    await expect(service.rotateCredentials(actor, account.id, { credentials: { kind: "role", roleArn: "arn:aws:iam::123456789012:role/test" } })).rejects.toMatchObject({ status: 403 });
  });
  it("pins AWS account identity and rejects credentials for a different AWS account", async () => {
    const f = await fixture();
    expect(f.account).toMatchObject({ externalAccountId: "123456789012" });
    await expect(service.rotateCredentials(f.actor, f.account.id, { credentials: { kind: "access_key", accessKeyId: "other-access-key", secretAccessKey: "other-secret-access-key" } })).rejects.toMatchObject({ status: 409 });
    const [stored] = await connection.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, f.account.id));
    expect(stored!.externalAccountId).toBe("123456789012");
  });
  it("rejects a concurrent first runtime identity pin during credential verification", async () => {
    const f = await fixture();
    await connection.db.update(cloudAccounts).set({ externalAccountId: null }).where(eq(cloudAccounts.id, f.account.id));
    const [before] = await connection.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, f.account.id));
    identityHook.run = async () => {
      await connection.db.transaction(async (tx) => {
        await tx.select().from(cloudAccounts).where(eq(cloudAccounts.id, f.account.id)).for("update");
        await tx.update(cloudAccounts).set({ externalAccountId: "999999999999" }).where(eq(cloudAccounts.id, f.account.id));
      });
    };
    try {
      await expect(service.rotateCredentials(f.actor, f.account.id, { credentials: { kind: "access_key", accessKeyId: "rotated-access-key", secretAccessKey: "rotated-secret-access-key" } })).rejects.toMatchObject({ status: 409 });
      const [after] = await connection.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, f.account.id));
      expect(after).toMatchObject({ externalAccountId: "999999999999", credentialCiphertext: before!.credentialCiphertext });
    } finally { identityHook.run = undefined; }
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
    await expect(bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false })).rejects.toMatchObject({ status: 409 });
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
  it.each(["never authorized", "revoked"] as const)("rejects fresh binding and takeover for a %s instance without side effects", async state => {
    const f = await fixture();
    if (state === "revoked") {
      await service.authorize(f.actor, f.instance.id, { managed: true, revision: 0 });
      await service.authorize(f.actor, f.instance.id, { managed: false, revision: 1 });
    }
    const [record] = await connection.db.insert(dnsRecords).values({ zoneId: f.zone.id, externalId: "existing", type: "A", name: "existing.example.com", content: f.address.address, ttl: 60, remoteHash: "existing" }).returning();
    for (const takeoverExisting of [false, true]) {
      await expect(bind(f.actor, { zoneId: f.zone.id, fqdn: takeoverExisting ? "existing" : "fresh", recordType: "A", slotId: f.slot.id, takeoverExisting })).rejects.toMatchObject({ status: 409 });
    }
    expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.zoneId, f.zone.id))).toEqual([]);
    expect(await connection.db.select().from(endpointPools).where(eq(endpointPools.ownerUserId, f.actor.id))).toEqual([]);
    expect(await connection.db.select().from(endpoints).innerJoin(cloudEndpointLinks, eq(cloudEndpointLinks.endpointId, endpoints.id)).where(eq(cloudEndpointLinks.slotId, f.slot.id))).toEqual([]);
    expect(await connection.db.select().from(bindingAssignments).where(eq(bindingAssignments.dnsRecordId, record!.id))).toEqual([]);
    expect(await connection.db.select().from(auditLogs).where(and(eq(auditLogs.ownerUserId, f.actor.id), eq(auditLogs.action, "cloud_binding.create")))).toEqual([]);
    expect(await connection.db.select().from(policyVersions).where(eq(policyVersions.actorUserId, f.actor.id))).toEqual([]);
    expect((await connection.db.select().from(dnsRecords).where(eq(dnsRecords.id, record!.id)))[0]).toMatchObject({ management: "unmanaged", managedByPoolId: null });
    expect(await connection.client.unsafe("select key from cloud_api_requests where actor_user_id = $1 and action = 'slot.bind'", [f.actor.id])).toEqual([]);
  });
  it("queues a durable reconcile when another name reuses a published current endpoint", async () => {
    const f = await fixture(true);
    const first = await bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false });
    await connection.db.update(managedAddressSlots).set({ currentVersion: 1 }).where(eq(managedAddressSlots.id, f.slot.id));
    const [current] = await connection.db.insert(endpointAddresses).values({ endpointId: first.endpoint.id, family: "4", address: f.address.address, state: "current", source: "cloud", healthState: "healthy", consecutiveSuccesses: 3 }).returning();
    await connection.db.update(endpoints).set({ healthState: "healthy" }).where(eq(endpoints.id, first.endpoint.id));
    const [record] = await connection.db.insert(dnsRecords).values({ zoneId: f.zone.id, externalId: "published", type: "A", name: first.binding.fqdn, content: f.address.address, ttl: 60, remoteHash: "published", management: "managed", managedByPoolId: first.pool.id }).returning();
    await connection.db.insert(bindingAssignments).values({ domainBindingId: first.binding.id, endpointId: first.endpoint.id, dnsRecordId: record!.id, desired: true, applied: true, reason: "published" });
    const second = await bind(f.actor, { zoneId: f.zone.id, fqdn: "other", recordType: "A", slotId: f.slot.id, poolId: first.pool.id, takeoverExisting: false });
    expect(second.endpoint.id).toBe(first.endpoint.id);
    expect(await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.endpointId, first.endpoint.id))).toEqual([current]);
    expect(await connection.db.select().from(reconcileIntents).where(and(eq(reconcileIntents.poolId, first.pool.id), eq(reconcileIntents.policyRevision, second.pool.policyRevision)))).toMatchObject([{ decisionRevision: second.pool.decisionRevision, trigger: "configuration", source: "user", force: false, completedAt: null }]);
    expect(second.pool.policyRevision).toBe(first.pool.policyRevision + 1);
    expect(second.pool.decisionRevision).toBeGreaterThan(first.pool.decisionRevision);
  });

  it("binds a managed instance with all automatic actions off without publishing scanned addresses", async () => {
    const f = await fixture(true);
    const result = await bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false });
    expect((await connection.db.select().from(instanceAuthorizations).where(eq(instanceAuthorizations.instanceId, f.instance.id)))[0]).toMatchObject({ managed: true, allowIpv4Rotation: false, allowIpv6Rotation: false, allowStopStart: false, allowReleaseAddress: false });
    expect(result.binding.fqdn).toBe("www.example.com");
    expect(result.endpoint.addressMode).toBe("cloud");
    expect(await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.endpointId, result.endpoint.id))).toEqual([]);
    await expect(bind(f.actor, { zoneId: f.zone.id, fqdn: "www.example.com.", recordType: "A", slotId: f.slot.id, takeoverExisting: false })).rejects.toMatchObject({ status: 409 });
    expect(await connection.db.select().from(endpointPools).where(eq(endpointPools.ownerUserId, f.actor.id))).toHaveLength(1);
  });
  it("rejects binding while an earlier DNS write for the same RRset is pending", async () => {
    const f = await fixture(true);
    const operations = new OperationsService({ db: connection.db } as never, { operations: { add: async () => ({}) } } as never);
    await operations.createDnsOperation({ ownerUserId: f.actor.id, actorUserId: f.actor.id, source: "user", idempotencyKey: randomUUID(), providerAccountId: f.zone.providerAccountId, zoneId: f.zone.id, zoneExternalId: f.zone.externalId, action: "create", record: { name: "www.example.com", type: "A", content: f.address.address, ttl: 60, providerMetadata: {} } });
    await expect(bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false })).rejects.toMatchObject({ status: 409 });
  });
  it("blocks generic DNS creation while an unverified cloud binding owns the name", async () => {
    const f = await fixture(true);
    await bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false });
    const dns = new DnsService({ db: connection.db } as never, {} as never, { createDnsOperation: async () => ({ created: true }) } as never);
    await expect(dns.createRecord(f.actor, f.zone.id, { name: "www", type: "A", content: "192.0.2.99", ttl: 60, providerMetadata: {} })).rejects.toMatchObject({ status: 409 });
  });
  it("rejects a new operation enqueued after the cloud claim", async () => {
    const f = await fixture(true);
    await bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false });
    const operations = new OperationsService({ db: connection.db } as never, { operations: { add: async () => ({}) } } as never);
    await expect(operations.createDnsOperation({ ownerUserId: f.actor.id, actorUserId: f.actor.id, source: "user", idempotencyKey: randomUUID(), providerAccountId: f.zone.providerAccountId, zoneId: f.zone.id, zoneExternalId: f.zone.externalId, action: "create", record: { name: "www.example.com", type: "A", content: f.address.address, ttl: 60, providerMetadata: {} } })).rejects.toMatchObject({ status: 409 });
  });
  it("serializes concurrent manual enqueue and cloud ownership claim", async () => {
    const f = await fixture(true);
    const operations = new OperationsService({ db: connection.db } as never, { operations: { add: async () => ({}) } } as never);
    const results = await Promise.allSettled([
      bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false }),
      operations.createDnsOperation({ ownerUserId: f.actor.id, actorUserId: f.actor.id, source: "user", idempotencyKey: randomUUID(), providerAccountId: f.zone.providerAccountId, zoneId: f.zone.id, zoneExternalId: f.zone.externalId, action: "create", record: { name: "www.example.com", type: "A", content: f.address.address, ttl: 60, providerMetadata: {} } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  });
  it("reuses an explicitly selected pool endpoint for the same slot", async () => {
    const f = await fixture(true);
    const first = await bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false });
    const second = await bind(f.actor, { zoneId: f.zone.id, fqdn: "other", recordType: "A", slotId: f.slot.id, poolId: first.pool.id, takeoverExisting: false });
    expect(second.endpoint.id).toBe(first.endpoint.id);
    expect(second.pool.id).toBe(first.pool.id);
  });
  it("keeps same-address takeover visible without declaring it externally verified", async () => {
    const f = await fixture(true);
    const [record] = await connection.db.insert(dnsRecords).values({ zoneId: f.zone.id, externalId: "record", type: "A", name: "www.example.com", content: f.address.address, ttl: 300, remoteHash: "existing" }).returning();
    const result = await bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: true });
    expect(result.binding.ttl).toBe(300);
    const [claimed] = await connection.db.select().from(dnsRecords).where(eq(dnsRecords.id, record!.id));
    expect(claimed).toMatchObject({ content: f.address.address, management: "managed", managedByPoolId: result.pool.id });
    expect(await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.endpointId, result.endpoint.id))).toEqual([]);
  });
  it("takes over equivalent expanded immutable IPv6 without changing existing DNS content", async () => {
    const f = await fixture(true);
    const [address] = await connection.db.insert(cloudAddresses).values({ interfaceId: f.iface.id, kind: "host", family: "6", address: "2001:db8::abcd", origin: "user", scanGeneration: 1 }).returning();
    const [slot] = await connection.db.insert(managedAddressSlots).values({ interfaceId: f.iface.id, family: "6", name: "v6", currentAddressId: address!.id }).returning();
    await connection.db.update(cloudInterfaces).set({ metadata: { primaryAddresses: [address!.address] } }).where(eq(cloudInterfaces.id, f.iface.id));
    expect((await service.slots(f.actor, f.instance.id)).find(row => row.slot.id === slot!.id)!.capability).toMatchObject({ available: false, reason: "primary_ipv6_immutable" });
    const content = "2001:0DB8:0000:0000:0000:0000:0000:ABCD";
    const [record] = await connection.db.insert(dnsRecords).values({ zoneId: f.zone.id, externalId: "v6-record", type: "AAAA", name: "www.example.com", content, ttl: 300, remoteHash: "existing" }).returning();
    const result = await bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "AAAA", slotId: slot!.id, takeoverExisting: true });
    expect(result.binding.recordType).toBe("AAAA");
    const [claimed] = await connection.db.select().from(dnsRecords).where(eq(dnsRecords.id, record!.id));
    expect(claimed).toMatchObject({ content, management: "managed", managedByPoolId: result.pool.id });
    expect(await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.endpointId, result.endpoint.id))).toEqual([]);
  });
  it("rejects takeover of a different address and cross-owner slots", async () => {
    const f = await fixture(true); const other = await fixture(true);
    await connection.db.insert(dnsRecords).values({ zoneId: f.zone.id, externalId: "record", type: "A", name: "www.example.com", content: "192.0.2.99", ttl: 60, remoteHash: "existing" });
    await expect(bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: true })).rejects.toMatchObject({ status: 409 });
    await expect(bind(f.actor, { zoneId: f.zone.id, fqdn: "other", recordType: "A", slotId: other.slot.id, takeoverExisting: false })).rejects.toMatchObject({ status: 404 });
    expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.zoneId, f.zone.id))).toEqual([]);
  });
});


describe("cloud request idempotency", () => {
  it("requires a client Idempotency-Key on both creation routes", () => {
    const controller = new CloudController({} as never, {} as never);
    expect(() => controller.create({} as never, {} as never, undefined)).toThrow("Idempotency-Key is required");
    expect(() => controller.bind({} as never, randomUUID(), {} as never, undefined)).toThrow("Idempotency-Key is required");
  });
  it("replays concurrent account creation and rejects a changed request without persisting credentials", async () => {
    const f = await fixture();
    const key = randomUUID();
    const input = { name: "Idempotent", provider: "aws" as const, regions: ["us-east-1", "ap-southeast-2"], credentials: { kind: "access_key" as const, accessKeyId: "request-access-key", secretAccessKey: "request-secret-access-key" } };
    let verifications = 0;
    identityHook.run = async () => { verifications++; };
    const [first, replay] = await Promise.all([create(f.actor, input, key), create(f.actor, { ...input, regions: [...input.regions].reverse() }, key)]);
    expect(verifications).toBe(1);
    identityHook.run = undefined;
    expect(replay).toEqual(first);
    await connection.db.update(cloudAccounts).set({ name: "Edited after creation" }).where(eq(cloudAccounts.id, first.id));
    const restartedService = new CloudService({ db: connection.db } as never, queue as never);
    expect(await restartedService.create(f.actor, input, key)).toEqual(first);
    expect(await connection.db.select().from(cloudAccounts).where(eq(cloudAccounts.ownerUserId, f.actor.id))).toHaveLength(2);
    await expect(create(f.actor, { ...input, credentials: { ...input.credentials, secretAccessKey: "changed-secret-access-key" } }, key)).rejects.toMatchObject({ status: 409 });
    const receipts = await connection.client.unsafe("select row_to_json(r)::text as payload from cloud_api_requests r where key = $1", [key]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.payload).not.toContain(input.credentials.secretAccessKey);
    expect(receipts[0]!.payload).not.toContain(input.credentials.accessKeyId);
  });
  it("replays a committed binding response and conflicts on a different canonical request", async () => {
    const f = await fixture(true); const key = randomUUID();
    const input = { zoneId: f.zone.id, fqdn: "www", recordType: "A" as const, slotId: f.slot.id, takeoverExisting: false };
    const first = await bind(f.actor, input, key);
    await connection.db.update(managedAddressSlots).set({ currentAddressId: null }).where(eq(managedAddressSlots.id, f.slot.id));
    const replay = await bind(f.actor, { ...input, fqdn: "WWW.EXAMPLE.COM." }, key);
    expect(replay).toEqual(first);
    await expect(bind(f.actor, { ...input, fqdn: "different" }, key)).rejects.toMatchObject({ status: 409 });
    expect(await connection.db.select().from(endpointPools).where(eq(endpointPools.ownerUserId, f.actor.id))).toHaveLength(1);
    expect(await connection.db.select().from(domainBindings).where(eq(domainBindings.zoneId, f.zone.id))).toHaveLength(1);
  });
  it("rolls back the receipt when binding fails so a later retry can complete", async () => {
    const f = await fixture(true); const key = randomUUID();
    const input = { zoneId: f.zone.id, fqdn: "www", recordType: "A" as const, slotId: f.slot.id, takeoverExisting: false };
    await connection.db.update(cloudAccounts).set({ enabled: false }).where(eq(cloudAccounts.id, f.account.id));
    await expect(bind(f.actor, input, key)).rejects.toMatchObject({ status: 409 });
    expect(await connection.client.unsafe("select key from cloud_api_requests where key = $1", [key])).toHaveLength(0);
    await connection.db.update(cloudAccounts).set({ enabled: true }).where(eq(cloudAccounts.id, f.account.id));
    expect(await bind(f.actor, input, key)).toMatchObject({ binding: { fqdn: "www.example.com" } });
  });
  it("checks ownership and actor identity before replaying an account creation", async () => {
    const f = await fixture(); const other = await fixture(); const key = randomUUID();
    const input = { name: "Replay", provider: "aws" as const, credentials: { kind: "access_key" as const, accessKeyId: "test-access-key", secretAccessKey: "test-secret-access-key" } };
    const account = await create(f.actor, input, key);
    const otherAccount = await create(other.actor, input, key);
    expect(otherAccount.id).not.toBe(account.id);
    expect(otherAccount.ownerUserId).toBe(other.actor.id);
    await connection.db.update(cloudAccounts).set({ ownerUserId: other.actor.id }).where(eq(cloudAccounts.id, account.id));
    await expect(create(f.actor, input, key)).rejects.toMatchObject({ status: 404 });
  });
  it("gives each actor an independent keyspace for binding and replay", async () => {
    const firstOwner = await fixture(true); const secondOwner = await fixture(true); const key = randomUUID();
    const firstInput = { zoneId: firstOwner.zone.id, fqdn: "www", recordType: "A" as const, slotId: firstOwner.slot.id, takeoverExisting: false };
    const secondInput = { zoneId: secondOwner.zone.id, fqdn: "www", recordType: "A" as const, slotId: secondOwner.slot.id, takeoverExisting: false };
    const [first, second] = await Promise.all([bind(firstOwner.actor, firstInput, key), bind(secondOwner.actor, secondInput, key)]);
    expect(first.binding.id).not.toBe(second.binding.id);
    expect(await bind(firstOwner.actor, firstInput, key)).toEqual(first);
    expect(await bind(secondOwner.actor, secondInput, key)).toEqual(second);
    await expect(bind(firstOwner.actor, { ...firstInput, fqdn: "different" }, key)).rejects.toMatchObject({ status: 409 });
    const receipts = await connection.client.unsafe("select actor_user_id from cloud_api_requests where key = $1", [key]);
    expect(receipts).toHaveLength(2);
  });
  it("rejects reuse of the same actor key for another action", async () => {
    const f = await fixture(true); const key = randomUUID();
    await create(f.actor, { name: "Action key", provider: "aws", credentials: { kind: "access_key", accessKeyId: "test-access-key", secretAccessKey: "test-secret-access-key" } }, key);
    await expect(bind(f.actor, { zoneId: f.zone.id, fqdn: "www", recordType: "A", slotId: f.slot.id, takeoverExisting: false }, key)).rejects.toMatchObject({ status: 409 });
  });
  it("checks current ownership before returning a stored binding response", async () => {
    const f = await fixture(true); const other = await fixture(true); const key = randomUUID();
    const input = { zoneId: f.zone.id, fqdn: "www", recordType: "A" as const, slotId: f.slot.id, takeoverExisting: false };
    await bind(f.actor, input, key);
    await expect(bind(other.actor, input, key)).rejects.toMatchObject({ status: 404 });
    await connection.db.update(cloudAccounts).set({ ownerUserId: other.actor.id }).where(eq(cloudAccounts.id, f.account.id));
    await expect(bind(f.actor, input, key)).rejects.toMatchObject({ status: 404 });
  });
});

import { policyVersions, cloudEndpointLinks, reconcileIntents } from "@masterdns/db";
import { PoolsService } from "../pools/pools.service.js";
it("restores a cloud policy through saved slot identity and current address retesting without replaying snapshot IPs", async () => {
 const f=await fixture();f.instance.externalId=`i-${randomUUID()}`;await connection.db.update(cloudInstances).set({externalId:f.instance.externalId}).where(eq(cloudInstances.id,f.instance.id));await service.authorize(f.actor,f.instance.id,{managed:true,revision:0});
 const bound=await bind(f.actor,{zoneId:f.zone.id,fqdn:"restore",recordType:"A",slotId:f.slot.id,takeoverExisting:false});
 const [version]=await connection.db.select().from(policyVersions).where(eq(policyVersions.poolId,bound.pool.id));
 expect((version!.snapshot as any).cloudLinks).toMatchObject([{slotId:f.slot.id,instanceId:f.instance.externalId}]);
 const snapshot={...(version!.snapshot as any),addresses:[{endpointId:bound.endpoint.id,family:"4",state:"current",source:"cloud",address:"198.51.100.250"}]};
 await connection.db.update(policyVersions).set({snapshot}).where(eq(policyVersions.id,version!.id));
 await connection.db.update(managedAddressSlots).set({currentVersion:1}).where(eq(managedAddressSlots.id,f.slot.id));
 await connection.db.insert(endpointAddresses).values({endpointId:bound.endpoint.id,family:"4",address:f.address.address,state:"current",source:"cloud",healthState:"healthy",consecutiveSuccesses:3});
 const pools=new PoolsService({db:connection.db} as never,{} as never);
 await pools.restorePolicyVersion(f.actor,bound.pool.id,version!.version,{force:true});
 const addresses=await connection.db.select().from(endpointAddresses).where(eq(endpointAddresses.endpointId,bound.endpoint.id));
 expect(addresses).toMatchObject([{address:f.address.address,healthState:"unknown",consecutiveSuccesses:0}]);
 const [slot]=await connection.db.select().from(managedAddressSlots).where(eq(managedAddressSlots.id,f.slot.id));expect(slot).toMatchObject({candidateAddressId:f.address.id,candidateVersion:2,currentVersion:1});
 expect(await connection.db.select().from(cloudEndpointLinks).where(eq(cloudEndpointLinks.endpointId,bound.endpoint.id))).toMatchObject([{slotId:f.slot.id}]);
 expect(await connection.db.select().from(reconcileIntents).where(and(eq(reconcileIntents.poolId,bound.pool.id),eq(reconcileIntents.source,"rollback")))).toMatchObject([{force:false}]);
});
