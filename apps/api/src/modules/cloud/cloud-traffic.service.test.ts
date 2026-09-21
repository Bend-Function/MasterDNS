import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cloudAccounts, cloudInstances, createDatabase, users } from "@masterdns/db";
import type { AuthUser } from "../../auth/auth.types.js";

const trafficHook = vi.hoisted(() => ({ run: vi.fn(async () => ({ month: "2026-09", periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-09-20T12:00:00Z", fetchedAt: "2026-09-20T12:00:00Z", source: "cloudwatch", incomingBytes: 100, outgoingBytes: 200, totalBytes: 300, allowance: null })) }));
vi.mock("@masterdns/cloud-providers", async (importOriginal) => ({
  ...await importOriginal<typeof import("@masterdns/cloud-providers")>(),
  createCloudAdapter: () => ({ verifyIdentity: async () => ({ externalAccountId: "123456789012" }), monthlyTraffic: () => trafficHook.run() }),
}));
vi.mock("../../config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { CloudService } from "./cloud.service.js";

const databaseName = `traffic_api_${randomUUID().replaceAll("-", "")}`;
let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
let service: CloudService;
beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  admin = createDatabase(root);
  await admin.client.unsafe(`create database "${databaseName}"`);
  const url = new URL(root); url.pathname = `/${databaseName}`;
  connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../../packages/db/drizzle", import.meta.url).pathname });
  service = new CloudService({ db: connection.db } as never, {} as never);
}, 30000);
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  await connection?.close();
  if (admin) { await admin.client.unsafe(`drop database if exists "${databaseName}"`); await admin.close(); }
});
async function fixture() {
  const [owner] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const actor = { id: owner!.id, role: "user" } as AuthUser;
  const account = await service.create(actor, { name: "AWS", provider: "aws", credentials: { kind: "access_key", accessKeyId: "test-access-key", secretAccessKey: "test-secret-access-key" } }, randomUUID());
  const [instance] = await connection.db.insert(cloudInstances).values({ accountId: account.id, service: "ec2", region: "us-east-1", externalId: "i-test", scanGeneration: 1 }).returning();
  return { actor, account, instance: instance! };
}

describe("monthly traffic API", () => {
  it("serves and caches monthly usage for an owned instance without write authorization", async () => {
    const f = await fixture();
    trafficHook.run.mockClear();
    expect(await service.monthlyTraffic(f.actor, f.instance.id)).toMatchObject({ status: "available", traffic: { totalBytes: 300 } });
    expect(await service.monthlyTraffic(f.actor, f.instance.id)).toMatchObject({ status: "available" });
    expect(trafficHook.run).toHaveBeenCalledTimes(1);
    const other = await fixture();
    await expect(service.monthlyTraffic(other.actor, f.instance.id)).rejects.toMatchObject({ status: 404 });
    await service.setEnabled(f.actor, f.account.id, false);
    expect(await service.monthlyTraffic(f.actor, f.instance.id)).toEqual({ status: "unavailable", reason: "account_disabled" });
    expect(trafficHook.run).toHaveBeenCalledTimes(1);
  });
  it("does not query excluded or removed instances", async () => {
    const f = await fixture();
    trafficHook.run.mockClear();
    await service.setRegions(f.actor, f.account.id, ["us-west-2"]);
    expect(await service.monthlyTraffic(f.actor, f.instance.id)).toEqual({ status: "unavailable", reason: "out_of_scope" });
    await service.setRegions(f.actor, f.account.id, null);
    await connection.db.update(cloudInstances).set({ metadata: { present: false } }).where(eq(cloudInstances.id, f.instance.id));
    expect(await service.monthlyTraffic(f.actor, f.instance.id)).toEqual({ status: "unavailable", reason: "resource_not_found" });
    expect(trafficHook.run).not.toHaveBeenCalled();
  });
  it("returns sanitized traffic errors and permits a subsequent retry", async () => {
    const f = await fixture();
    const { CloudError } = await import("@masterdns/cloud-providers");
    trafficHook.run.mockRejectedValueOnce(new CloudError("permission_denied", false));
    expect(await service.monthlyTraffic(f.actor, f.instance.id)).toEqual({ status: "unavailable", reason: "permission_denied" });
    trafficHook.run.mockRejectedValueOnce(new Error("secret-token"));
    expect(await service.monthlyTraffic(f.actor, f.instance.id)).toEqual({ status: "unavailable", reason: "query_failed" });
    expect(await service.monthlyTraffic(f.actor, f.instance.id)).toMatchObject({ status: "available" });
  });
  it("coalesces concurrent reads and expires the cache after five minutes or a UTC month change", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T23:58:00Z"));
    trafficHook.run.mockClear();
    await Promise.all(Array.from({ length: 3 }, () => service.monthlyTraffic(f.actor, f.instance.id)));
    expect(trafficHook.run).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    await service.monthlyTraffic(f.actor, f.instance.id);
    expect(trafficHook.run).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-10-01T00:06:00Z"));
    await service.monthlyTraffic(f.actor, f.instance.id);
    expect(trafficHook.run).toHaveBeenCalledTimes(3);
  });
  it("invalidates cached traffic after credential rotation and rejects a changed remote identity", async () => {
    const f = await fixture();
    trafficHook.run.mockClear();
    await service.monthlyTraffic(f.actor, f.instance.id);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 1000));
    await service.rotateCredentials(f.actor, f.account.id, { credentials: { kind: "access_key", accessKeyId: "rotated-key", secretAccessKey: "rotated-secret" } });
    expect(await service.monthlyTraffic(f.actor, f.instance.id)).toMatchObject({ status: "available" });
    expect(trafficHook.run).toHaveBeenCalledTimes(2);
    await connection.db.update(cloudAccounts).set({ externalAccountId: "other", updatedAt: new Date(Date.now() + 1000) }).where(eq(cloudAccounts.id, f.account.id));
    expect(await service.monthlyTraffic(f.actor, f.instance.id)).toEqual({ status: "unavailable", reason: "remote_identity_changed" });
    expect(trafficHook.run).toHaveBeenCalledTimes(2);
  });
});
