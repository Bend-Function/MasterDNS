import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ProviderError, type ProviderZone } from "@masterdns/contracts";
import { encryptJson } from "@masterdns/crypto";
import { auditLogs, createDatabase, providerAccounts, users, zones } from "@masterdns/db";
import { CloudflareDnsAdapter } from "@masterdns/providers";
import type { AuthUser } from "../../auth/auth.types.js";
vi.mock("../../config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
import { DnsService } from "./dns.service.js";

const databaseName = `zone_creation_${randomUUID().replaceAll("-", "")}`;
const accountId = "a".repeat(32);
let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
let dns: DnsService;
let remote: Map<string, ProviderZone>;
let writes: string[];
const enqueue = vi.fn();

beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  admin = createDatabase(root);
  await admin.client.unsafe(`create database "${databaseName}"`);
  const url = new URL(root); url.pathname = `/${databaseName}`;
  connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../../packages/db/drizzle", import.meta.url).pathname });
  dns = new DnsService({ db: connection.db } as never, { sync: { add: enqueue } } as never, {} as never);
  vi.spyOn(CloudflareDnsAdapter.prototype, "findZone").mockImplementation(async input => remote.get(input.name) ?? null);
  vi.spyOn(CloudflareDnsAdapter.prototype, "createZone").mockImplementation(async input => {
    writes.push(input.name);
    const zone = { externalId: randomUUID(), name: input.name, status: "pending" as const, providerMetadata: { accountId: input.accountId, zoneStatus: "pending", nameServers: ["amy.ns.cloudflare.com", "bob.ns.cloudflare.com"] } };
    remote.set(input.name, zone);
    if (input.name === "uncertain.com") throw new ProviderError("timeout", "transient_failure", "cloudflare");
    if (input.name === "denied.com") { remote.delete(input.name); throw new ProviderError("Cloudflare permission denied", "permission_denied", "cloudflare"); }
    return zone;
  });
}, 30_000);
beforeEach(() => { remote = new Map(); writes = []; enqueue.mockReset().mockResolvedValue({}); });
afterAll(async () => {
  vi.restoreAllMocks();
  await connection?.close();
  if (admin) { await admin.client.unsafe(`drop database if exists "${databaseName}"`); await admin.close(); }
});

async function fixture(provider: "cloudflare" | "aliyun" = "cloudflare", status: "active" | "disabled" | "error" = "active") {
  const [user] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test" }).returning();
  const actor = { id: user!.id, role: "user" } as AuthUser;
  const encrypted = encryptJson({ provider, apiToken: "test-token" }, Buffer.alloc(32, 1));
  const [account] = await connection.db.insert(providerAccounts).values({ ownerUserId: actor.id, provider, status, name: "DNS", credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag }).returning();
  const input = { providerAccountId: account!.id, cloudflareAccountId: accountId, name: "example.com" };
  return { actor, account: account!, input };
}

it("persists a newly created domain with NS instructions and an audit owned by the account owner", async () => {
  const f = await fixture();
  const result = await dns.createZone(f.actor, f.input);
  expect(result).toMatchObject({ name: "example.com", status: "created", zoneStatus: "pending", nameServers: ["amy.ns.cloudflare.com", "bob.ns.cloudflare.com"] });
  expect(await connection.db.select().from(zones).where(eq(zones.id, result.zoneId))).toMatchObject([{ providerAccountId: f.account.id, nameAscii: "example.com", providerMetadata: { accountId, zoneStatus: "pending" } }]);
  const audit = await connection.db.select().from(auditLogs).where(eq(auditLogs.resourceId, result.zoneId));
  expect(audit).toMatchObject([{ ownerUserId: f.actor.id, actorUserId: f.actor.id, action: "zone.create" }]);
  expect(JSON.stringify(audit)).not.toContain("test-token");
  expect(await dns.listZones(f.actor)).toMatchObject([{ zone: { id: result.zoneId, status: "pending" } }]);
});

it("does not create duplicate remote or local zones when a submission is repeated", async () => {
  const f = await fixture();
  const first = await dns.createZone(f.actor, f.input);
  expect(await dns.createZone(f.actor, f.input)).toMatchObject({ status: "existing", zoneId: first.zoneId });
  expect(writes).toEqual(["example.com"]);
  expect(await connection.db.select().from(zones).where(eq(zones.providerAccountId, f.account.id))).toHaveLength(1);
});

it("imports an existing remote domain without a create request", async () => {
  const f = await fixture();
  remote.set("example.com", { externalId: "existing-zone", name: "example.com", status: "active", providerMetadata: { accountId, zoneStatus: "active", nameServers: ["amy.ns.cloudflare.com"] } });
  expect(await dns.createZone(f.actor, f.input)).toMatchObject({ status: "existing", zoneStatus: "active", nameServers: ["amy.ns.cloudflare.com"] });
  expect(writes).toEqual([]);
});

it("does not present a moved Cloudflare domain as active", async () => {
  const f = await fixture();
  remote.set("example.com", { externalId: "moved-zone", name: "example.com", status: "pending", providerMetadata: { accountId, zoneStatus: "moved", nameServers: ["amy.ns.cloudflare.com"] } });
  expect(await dns.createZone(f.actor, f.input)).toMatchObject({ status: "existing", zoneStatus: "pending" });
  expect(await dns.listZones(f.actor)).toMatchObject([{ zone: { status: "pending", providerMetadata: { zoneStatus: "moved" } } }]);
});

it("continues a batch after one domain fails and deduplicates normalized names", async () => {
  const f = await fixture();
  const result = await dns.createZones(f.actor, { ...f.input, names: ["A.COM", "a.com.", "denied.com", "b.com"] });
  expect(result.results).toMatchObject([{ name: "a.com", status: "created" }, { name: "denied.com", status: "failed", error: { code: "permission_denied" } }, { name: "b.com", status: "created" }]);
  expect(writes).toEqual(["a.com", "denied.com", "b.com"]);
  expect(await connection.db.select().from(zones).where(eq(zones.providerAccountId, f.account.id))).toHaveLength(2);
});

it("reconciles a timed-out create that succeeded remotely before attempting another POST", async () => {
  const f = await fixture();
  expect(await dns.createZone(f.actor, { ...f.input, name: "uncertain.com" })).toMatchObject({ status: "existing", zoneStatus: "pending" });
  expect(writes).toEqual(["uncertain.com"]);
});

it("rejects another user's account before making provider calls", async () => {
  const f = await fixture();
  await expect(dns.createZone({ ...f.actor, id: randomUUID() }, f.input)).rejects.toMatchObject({ status: 404 });
  expect(writes).toEqual([]);
});

it("allows administrators to add a domain with ownership and audit attributed correctly", async () => {
  const f = await fixture();
  const [adminUser] = await connection.db.insert(users).values({ username: randomUUID(), passwordHash: "test", role: "admin" }).returning();
  const result = await dns.createZone({ ...f.actor, id: adminUser!.id, role: "admin" }, f.input);
  expect(await connection.db.select().from(auditLogs).where(eq(auditLogs.resourceId, result.zoneId))).toMatchObject([{ ownerUserId: f.actor.id, actorUserId: adminUser!.id }]);
});

it.each([["aliyun", "active", 400], ["cloudflare", "disabled", 409], ["cloudflare", "error", 409]] as const)("rejects unavailable account %s/%s before creating a domain", async (provider, status, expectedStatus) => {
  const f = await fixture(provider, status);
  await expect(dns.createZone(f.actor, f.input)).rejects.toMatchObject({ status: expectedStatus });
  expect(writes).toEqual([]);
});

it("rejects an invalid batch before creating its first domain", async () => {
  const f = await fixture();
  await expect(dns.createZones(f.actor, { ...f.input, names: ["a.com", "https://bad.com"] })).rejects.toThrow();
  expect(writes).toEqual([]);
});

it("rejects a provider response outside the requested Cloudflare account", async () => {
  const f = await fixture();
  remote.set("example.com", { externalId: "wrong-zone", name: "example.com", status: "active", providerMetadata: { accountId: "b".repeat(32) } });
  await expect(dns.createZone(f.actor, f.input)).rejects.toMatchObject({ status: 409 });
  expect(await connection.db.select().from(zones).where(eq(zones.providerAccountId, f.account.id))).toEqual([]);
});

it("returns the created domain even if the optional record sync cannot be queued", async () => {
  const f = await fixture();
  enqueue.mockRejectedValue(new Error("redis unavailable"));
  expect(await dns.createZone(f.actor, f.input)).toMatchObject({ status: "created" });
  expect(await connection.db.select().from(zones).where(eq(zones.providerAccountId, f.account.id))).toHaveLength(1);
});

it("returns the durable domain without waiting for a disconnected Redis queue", async () => {
  const f = await fixture();
  enqueue.mockImplementation(() => new Promise(() => {}));
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("domain response blocked by Redis")), 1_000); });
  try {
    expect(await Promise.race([dns.createZone(f.actor, f.input), deadline])).toMatchObject({ status: "created" });
  } finally { clearTimeout(timeout!); }
});
