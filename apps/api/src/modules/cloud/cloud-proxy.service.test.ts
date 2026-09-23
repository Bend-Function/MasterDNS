import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLogs, cloudAccounts, createDatabase, users } from "@masterdns/db";
import { decryptJson, encryptJson } from "@masterdns/crypto";
import type { AuthUser } from "../../auth/auth.types.js";

const mocks = vi.hoisted(() => ({
  identity: "123456789012",
  verified: [] as Array<Record<string, unknown>>,
  fetchCalls: [] as Array<{ proxyUrl: string | undefined; url: string; init: RequestInit | undefined }>,
}));
vi.mock("../../config/env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
vi.mock("@masterdns/cloud-providers", async original => ({
  ...await original<any>(),
  createCloudAdapter: (config: { credentials: Record<string, unknown> }) => ({ verifyIdentity: async () => {
    mocks.verified.push(config.credentials);
    return { externalAccountId: mocks.identity };
  } }),
  createCloudFetch: (proxyUrl?: string) => async (url: string, init?: RequestInit) => {
    mocks.fetchCalls.push({ proxyUrl, url, init });
    return new Response(JSON.stringify({ ip: "203.0.113.9" }), { status: 200 });
  },
}));

import { CloudProxyService } from "./cloud-proxy.service.js";

const databaseName = `cloud_proxy_api_${randomUUID().replaceAll("-", "")}`;
const key = Buffer.alloc(32, 1);
let admin: ReturnType<typeof createDatabase>;
let connection: ReturnType<typeof createDatabase>;
let service: CloudProxyService;
let increments = 0;

beforeAll(async () => {
  const root = process.env.MASTERDNS_TEST_DATABASE_URL;
  if (!root) throw new Error("MASTERDNS_TEST_DATABASE_URL is required");
  admin = createDatabase(root);
  await admin.client.unsafe(`create database "${databaseName}"`);
  const url = new URL(root); url.pathname = `/${databaseName}`;
  connection = createDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: new URL("../../../../../packages/db/drizzle", import.meta.url).pathname });
  service = new CloudProxyService({ db: connection.db } as never, { incrementRateLimit: async () => ++increments } as never);
}, 30_000);

beforeEach(() => {
  mocks.identity = "123456789012";
  mocks.verified.length = 0;
  mocks.fetchCalls.length = 0;
  increments = 0;
});

afterAll(async () => {
  await connection?.close();
  if (admin) { await admin.client.unsafe(`drop database if exists "${databaseName}"`); await admin.close(); }
});

async function fixture() {
  const [owner, other, administrator] = await connection.db.insert(users).values([
    { username: randomUUID(), passwordHash: "test", role: "user" },
    { username: randomUUID(), passwordHash: "test", role: "user" },
    { username: randomUUID(), passwordHash: "test", role: "admin" },
  ]).returning();
  const encrypted = encryptJson({ kind: "access_key", accessKeyId: "test-access-key", secretAccessKey: "test-secret-access-key" }, key);
  const [account] = await connection.db.insert(cloudAccounts).values({
    ownerUserId: owner!.id, provider: "aws", name: "AWS", externalAccountId: "123456789012",
    credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag,
  }).returning();
  const actor = (user: typeof owner) => ({ id: user!.id, role: user!.role } as AuthUser);
  return { account: account!, owner: actor(owner), other: actor(other), admin: actor(administrator) };
}

describe("cloud proxy configuration", () => {
  it("encrypts the URL with credentials and only returns a sanitized endpoint", async () => {
    const f = await fixture();
    const result = await service.set(f.owner, f.account.id, "socks5h://alice:secret@proxy.example:1080");
    expect(result).toEqual({ configured: true, endpoint: "socks5h://proxy.example:1080" });
    expect(mocks.verified[0]).toMatchObject({ accessKeyId: "test-access-key", proxyUrl: "socks5h://alice:secret@proxy.example:1080" });
    const [stored] = await connection.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, f.account.id));
    expect(decryptJson<Record<string, unknown>>({ ciphertext: stored!.credentialCiphertext, iv: stored!.credentialIv, tag: stored!.credentialTag, keyVersion: stored!.credentialKeyVersion }, key)).toMatchObject({ proxyUrl: "socks5h://alice:secret@proxy.example:1080" });
    expect(JSON.stringify(await connection.db.select().from(auditLogs).where(eq(auditLogs.resourceId, f.account.id)))).not.toContain("alice");
    expect((await connection.db.select().from(auditLogs).where(eq(auditLogs.resourceId, f.account.id)))[0]).toMatchObject({ beforeSnapshot: { configured: false }, afterSnapshot: { configured: true } });
    expect(await service.get(f.admin, f.account.id)).toEqual({ configured: true, endpoint: "socks5h://proxy.example:1080" });
  });

  it("rejects another owner before decrypting, verifying, or checking connectivity", async () => {
    const f = await fixture();
    await expect(service.get(f.other, f.account.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.set(f.other, f.account.id, "socks5h://alice:secret@proxy.example:1080")).rejects.toMatchObject({ status: 404 });
    await expect(service.check(f.other, f.account.id, {})).rejects.toMatchObject({ status: 404 });
    expect(mocks.verified).toEqual([]);
    expect(mocks.fetchCalls).toEqual([]);
  });

  it("keeps stored credentials unchanged when the candidate route has another identity", async () => {
    const f = await fixture();
    mocks.identity = "999999999999";
    await expect(service.set(f.owner, f.account.id, "socks5h://proxy.example:1080")).rejects.toMatchObject({ status: 409 });
    const [stored] = await connection.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, f.account.id));
    expect(stored!.credentialCiphertext).toBe(f.account.credentialCiphertext);
  });

  it("clears only proxy configuration after verifying the direct route", async () => {
    const f = await fixture();
    await service.set(f.owner, f.account.id, "socks5h://alice:secret@proxy.example:1080");
    expect(await service.set(f.owner, f.account.id, null)).toEqual({ configured: false, endpoint: null });
    expect(mocks.verified.at(-1)).not.toHaveProperty("proxyUrl");
    const [stored] = await connection.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, f.account.id));
    expect(decryptJson<Record<string, unknown>>({ ciphertext: stored!.credentialCiphertext, iv: stored!.credentialIv, tag: stored!.credentialTag, keyVersion: stored!.credentialKeyVersion }, key)).toMatchObject({ accessKeyId: "test-access-key" });
  });

  it("checks draft and saved proxies against only the fixed HTTPS diagnostic endpoint", async () => {
    const f = await fixture();
    const draft = await service.check(f.owner, f.account.id, { proxyUrl: "socks5h://alice:secret@proxy.example:1080" });
    expect(draft).toMatchObject({ ok: true, ip: "203.0.113.9", error: null, checkedAt: expect.any(String), latencyMs: expect.any(Number) });
    expect(mocks.fetchCalls[0]).toMatchObject({ proxyUrl: "socks5h://alice:secret@proxy.example:1080", url: "https://api64.ipify.org/?format=json", init: { redirect: "manual", signal: expect.any(AbortSignal) } });
    expect(JSON.stringify(mocks.fetchCalls[0])).not.toContain("test-secret-access-key");
    await service.set(f.owner, f.account.id, "socks5://proxy.example:1080");
    await service.check(f.owner, f.account.id, {});
    expect(mocks.fetchCalls[1]!.proxyUrl).toBe("socks5://proxy.example:1080");
  });

  it("rate limits manual checks before opening another network connection", async () => {
    const f = await fixture();
    for (let index = 0; index < 6; index++) await service.check(f.owner, f.account.id, { proxyUrl: "socks5h://proxy.example:1080" });
    await expect(service.check(f.owner, f.account.id, { proxyUrl: "socks5h://proxy.example:1080" })).rejects.toMatchObject({ status: 429 });
    expect(mocks.fetchCalls).toHaveLength(6);
  });
});
