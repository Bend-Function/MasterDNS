import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, cloudScanScopes, createDatabase, instanceAuthorizations, managedAddressSlots, users } from "@masterdns/db";
import { encryptJson } from "@masterdns/crypto";
import type { CloudAdapter, CloudInventory } from "@masterdns/cloud-providers";
vi.mock("@masterdns/cloud-providers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@masterdns/cloud-providers")>(),
  createCloudAdapter: ({ credentials }: { credentials: { accessKeyId?: string } }) => ({ verifyIdentity: async () => ({ externalAccountId: credentials.accessKeyId?.startsWith("other-") ? "999999999999" : "123456789012" }) }),
}));
vi.mock("../env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { CloudRuntimeService } from "./cloud-runtime.service.js";
import { CloudSyncService } from "./cloud-sync.service.js";

const databaseName = `cloud_sync_${randomUUID().replaceAll("-", "")}`;
let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  admin = createDatabase(root); await admin.client.unsafe(`create database "${databaseName}"`);
  const url = new URL(root); url.pathname = `/${databaseName}`; connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../packages/db/drizzle", import.meta.url).pathname });
}, 30000);
afterAll(async () => {
  await connection?.close();
  if (admin) { await admin.client.unsafe(`drop database if exists "${databaseName}"`); await admin.close(); }
});
async function fixture() {
  const [owner] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const [account] = await connection.db.insert(cloudAccounts).values({ ownerUserId: owner!.id, provider: "aws", name: "test", credentialCiphertext: "cipher", credentialIv: "iv", credentialTag: "tag" }).returning();
  const item: CloudInventory = { ref: { accountId: account!.id, service: "ec2", region: "us-east-1", instanceId: "i-test" }, name: "test", state: "running", interfaces: [{ id: "eni-test", deviceIndex: 0, addresses: [{ address: "192.0.2.1", family: 4, primary: true }] }] };
  const adapter = { verifyIdentity: vi.fn().mockResolvedValue({ externalAccountId: "123456789012" }), listScopes: vi.fn().mockResolvedValue(["us-east-1"]), discover: vi.fn().mockResolvedValue({ items: [item] }) };
  const runtime = { adapter: vi.fn().mockResolvedValue(adapter) };
  const service = new CloudSyncService({ db: connection.db } as never, runtime as never, {} as never);
  return { account: account!, item, adapter, runtime, service };
}
describe("complete cloud scope sync", () => {
  it("pins first runtime identity and rejects a later AWS account mismatch", async () => {
    const f = await fixture();
    const encrypted = encryptJson({ kind: "access_key", accessKeyId: "test-access", secretAccessKey: "test-secret" }, Buffer.alloc(32, 1));
    await connection.db.update(cloudAccounts).set({ credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag }).where(eq(cloudAccounts.id, f.account.id));
    const runtime = new CloudRuntimeService({ db: connection.db } as never);
    await runtime.adapter(f.account.id, "ec2");
    const [pinned] = await connection.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, f.account.id));
    expect(pinned!.externalAccountId).toBe("123456789012");
    const foreign = encryptJson({ kind: "access_key", accessKeyId: "other-access", secretAccessKey: "test-secret" }, Buffer.alloc(32, 1));
    await connection.db.update(cloudAccounts).set({ credentialCiphertext: foreign.ciphertext, credentialIv: foreign.iv, credentialTag: foreign.tag }).where(eq(cloudAccounts.id, f.account.id));
    await expect(runtime.adapter(f.account.id, "ec2")).rejects.toMatchObject({ code: "remote_identity_changed" });
  });
  it("retains the old generation and inventory if any page fails", async () => {
    const f = await fixture(); await f.service.scanScope(f.account.id, "ec2", "us-east-1", f.adapter as unknown as CloudAdapter);
    f.adapter.discover.mockResolvedValueOnce({ items: [], cursor: "second" }).mockRejectedValueOnce(Object.assign(new Error("secret provider message"), { code: "AccessDenied" }));
    expect(await f.service.scanScope(f.account.id, "ec2", "us-east-1", f.adapter as unknown as CloudAdapter)).toMatchObject({ scopeStatus: "failed", removedInstances: 0 });
    const [scope] = await connection.db.select().from(cloudScanScopes).where(eq(cloudScanScopes.accountId, f.account.id));
    expect(scope).toMatchObject({ generation: 1, lastError: "sync_failed" });
    const [instance] = await connection.db.select().from(cloudInstances).where(eq(cloudInstances.accountId, f.account.id));
    expect(instance).toMatchObject({ scanGeneration: 1, metadata: { present: true } });
  });
  it("records new observations without changing existing slots or authorizations", async () => {
    const f = await fixture(); await f.service.scanScope(f.account.id, "ec2", "us-east-1", f.adapter as unknown as CloudAdapter);
    const [instance] = await connection.db.select().from(cloudInstances).where(eq(cloudInstances.accountId, f.account.id));
    const [iface] = await connection.db.select().from(cloudInterfaces).where(eq(cloudInterfaces.instanceId, instance!.id));
    const [slot] = await connection.db.select().from(managedAddressSlots).where(eq(managedAddressSlots.interfaceId, iface!.id));
    expect(slot).toMatchObject({ currentVersion: 0 });
    f.item.interfaces[0]!.addresses[0]!.address = "192.0.2.2";
    await f.service.scanScope(f.account.id, "ec2", "us-east-1", f.adapter as unknown as CloudAdapter);
    const [after] = await connection.db.select().from(managedAddressSlots).where(eq(managedAddressSlots.id, slot!.id));
    expect(after).toMatchObject({ currentAddressId: slot!.currentAddressId, currentVersion: 0, candidateAddressId: null });
    expect(await connection.db.select().from(cloudAddresses).where(eq(cloudAddresses.interfaceId, iface!.id))).toHaveLength(2);
    expect(await connection.db.select().from(instanceAuthorizations).where(eq(instanceAuthorizations.instanceId, instance!.id))).toEqual([]);
  });
  it("does not duplicate a rotated secondary slot or overwrite its system ownership", async () => {
    const f = await fixture(); f.item.interfaces[0]!.addresses[0]!.primary = false;
    await f.service.scanScope(f.account.id, "ec2", "us-east-1", f.adapter as unknown as CloudAdapter);
    const [instance] = await connection.db.select().from(cloudInstances).where(eq(cloudInstances.accountId, f.account.id));
    const [iface] = await connection.db.select().from(cloudInterfaces).where(eq(cloudInterfaces.instanceId, instance!.id));
    const [slot] = await connection.db.select().from(managedAddressSlots).where(eq(managedAddressSlots.interfaceId, iface!.id));
    const [rotated] = await connection.db.insert(cloudAddresses).values({ interfaceId: iface!.id, family: "4", address: "192.0.2.2", kind: "host", origin: "system", remoteAllocationId: "eipalloc-system", scanGeneration: 1 }).returning();
    await connection.db.update(managedAddressSlots).set({ currentAddressId: rotated!.id, currentVersion: 1 }).where(eq(managedAddressSlots.id, slot!.id));
    f.item.interfaces[0]!.addresses[0]!.address = "192.0.2.2";
    f.item.interfaces[0]!.addresses[0]!.allocationId = "eipalloc-different";
    await f.service.scanScope(f.account.id, "ec2", "us-east-1", f.adapter as unknown as CloudAdapter);
    expect(await connection.db.select().from(managedAddressSlots).where(eq(managedAddressSlots.interfaceId, iface!.id))).toHaveLength(1);
    const [address] = await connection.db.select().from(cloudAddresses).where(eq(cloudAddresses.id, rotated!.id));
    expect(address).toMatchObject({ origin: "system", remoteAllocationId: "eipalloc-system", scanGeneration: 2 });
  });
  it("marks missing instances absent only after successful full scan", async () => {
    const f = await fixture(); await f.service.scanScope(f.account.id, "ec2", "us-east-1", f.adapter as unknown as CloudAdapter);
    f.adapter.discover.mockResolvedValue({ items: [] });
    expect(await f.service.scanScope(f.account.id, "ec2", "us-east-1", f.adapter as unknown as CloudAdapter)).toMatchObject({ scopeStatus: "complete", removedInstances: 1 });
    const [instance] = await connection.db.select().from(cloudInstances).where(eq(cloudInstances.accountId, f.account.id));
    expect(instance).toMatchObject({ metadata: { present: false } });
  });
  it("restricts discovery to saved regions and ignores out-of-scope direct scans", async () => {
    const f = await fixture();
    await connection.db.update(cloudAccounts).set({ regions: ["ap-southeast-2"] }).where(eq(cloudAccounts.id, f.account.id));
    f.adapter.listScopes.mockResolvedValue(["us-east-1", "ap-southeast-2"]);
    f.adapter.discover.mockResolvedValue({ items: [] });
    await f.service.sync(f.account.id);
    expect(f.adapter.discover.mock.calls.map((call) => call[0])).toEqual(["ap-southeast-2", "ap-southeast-2"]);
    expect(await f.service.scanScope(f.account.id, "ec2", "us-east-1", f.adapter as unknown as CloudAdapter)).toMatchObject({ scopeStatus: "failed", errorCode: "region_excluded" });
  });
  it("uses a single adapter per service across regions", async () => {
    const f = await fixture(); f.adapter.listScopes.mockResolvedValue(["us-east-1", "ap-southeast-2"]);
    f.adapter.discover.mockResolvedValue({ items: [] });
    const results = await f.service.sync(f.account.id);
    expect(results).toHaveLength(4);
    expect(results.every((result) => result.scopeStatus === "complete")).toBe(true);
    expect(f.runtime.adapter.mock.calls).toEqual([[f.account.id, "ec2"], [f.account.id, "lightsail"]]);
  });
  it("does not let an older overlapping scan overwrite a completed generation", async () => {
    const f = await fixture();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    f.adapter.discover.mockImplementationOnce(async () => { started(); await held; return { items: [f.item] }; });
    const older = f.service.scanScope(f.account.id, "ec2", "us-east-1", f.adapter as unknown as CloudAdapter);
    await ready;
    f.adapter.discover.mockResolvedValue({ items: [] });
    expect(await f.service.scanScope(f.account.id, "ec2", "us-east-1", f.adapter as unknown as CloudAdapter)).toMatchObject({ scopeStatus: "complete" });
    release();
    expect(await older).toMatchObject({ scopeStatus: "failed" });
    expect(await connection.db.select().from(cloudInstances).where(eq(cloudInstances.accountId, f.account.id))).toEqual([]);
    const [scope] = await connection.db.select().from(cloudScanScopes).where(eq(cloudScanScopes.accountId, f.account.id));
    expect(scope).toMatchObject({ generation: 1, lastError: null });
  });
  it("does not commit a scan if account is disabled during discovery", async () => {
    const f = await fixture(); f.adapter.discover.mockImplementation(async () => {
      await connection.db.update(cloudAccounts).set({ enabled: false }).where(eq(cloudAccounts.id, f.account.id));
      return { items: [f.item] };
    });
    expect(await f.service.scanScope(f.account.id, "ec2", "us-east-1", f.adapter as unknown as CloudAdapter)).toMatchObject({ scopeStatus: "failed" });
    expect(await connection.db.select().from(cloudInstances).where(eq(cloudInstances.accountId, f.account.id))).toEqual([]);
  });
});
