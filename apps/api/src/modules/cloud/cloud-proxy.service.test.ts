import { randomUUID } from "node:crypto";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLogs, cloudAccounts, cloudProxyProfiles, createDatabase, users } from "@masterdns/db";
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
  it("stores reusable encrypted profiles and assigns one to multiple owned accounts", async () => {
    const first = await fixture();
    const [second] = await connection.db.insert(cloudAccounts).values({ ...first.account, id: randomUUID(), name: "Second" }).returning();
    const profile = await service.createProfile(first.owner, { name: "出口 A", proxyUrl: "socks5h://alice:secret@proxy.example:1080" });
    expect(JSON.stringify(profile)).not.toContain("secret");
    expect(await service.selectProfile(first.owner, first.account.id, profile.id)).toMatchObject({ proxyProfileId: profile.id });
    expect(await service.selectProfile(first.owner, second!.id, profile.id)).toMatchObject({ proxyProfileId: profile.id });
    expect((await service.listProfiles(first.owner))[0]).toMatchObject({ id: profile.id, assignedAccountIds: expect.arrayContaining([first.account.id, second!.id]) });
    await service.updateProfile(first.owner, profile.id, { name: "出口 A2", proxyUrl: "socks5h://alice:new-secret@new.example:1080" });
    const accounts = await connection.db.select().from(cloudAccounts);
    for (const account of accounts.filter(item => [first.account.id, second!.id].includes(item.id))) {
      expect(decryptJson<Record<string, unknown>>({ ciphertext: account.credentialCiphertext, iv: account.credentialIv, tag: account.credentialTag, keyVersion: account.credentialKeyVersion }, key)).toMatchObject({ proxyUrl: "socks5h://alice:new-secret@new.example:1080" });
    }
    await expect(service.deleteProfile(first.owner, profile.id)).rejects.toMatchObject({ status: 409 });
    await service.selectProfile(first.owner, first.account.id, null);
    await service.selectProfile(first.owner, second!.id, null);
    await service.deleteProfile(first.owner, profile.id);
    expect(await connection.db.select().from(cloudProxyProfiles).where(eq(cloudProxyProfiles.id, profile.id))).toEqual([]);
  });

  it("rejects cross-owner selection and a mismatched routed identity without changing credentials", async () => {
    const first = await fixture(); const second = await fixture();
    const profile = await service.createProfile(first.owner, { name: "Private", proxyUrl: "socks5://proxy.example:1080" });
    await expect(service.selectProfile(second.owner, second.account.id, profile.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.selectProfile(first.admin, second.account.id, profile.id)).rejects.toMatchObject({ status: 404 });
    mocks.identity = "999999999999";
    await expect(service.selectProfile(first.owner, first.account.id, profile.id)).rejects.toMatchObject({ status: 409 });
    const [stored] = await connection.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, first.account.id));
    expect(stored!.credentialCiphertext).toBe(first.account.credentialCiphertext);
  });

  it("rolls back a shared profile edit if an assigned account rejects the new route", async () => {
    const f = await fixture();
    const profile = await service.createProfile(f.owner, { name: "Shared", proxyUrl: "socks5h://old.example:1080" });
    await service.selectProfile(f.owner, f.account.id, profile.id);
    const [before] = await connection.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, f.account.id));
    mocks.identity = "999999999999";
    await expect(service.updateProfile(f.owner, profile.id, { name: "Updated", proxyUrl: "socks5h://new.example:1080" })).rejects.toMatchObject({ status: 409 });
    const [after] = await connection.db.select().from(cloudAccounts).where(eq(cloudAccounts.id, f.account.id));
    expect(after!.credentialCiphertext).toBe(before!.credentialCiphertext);
    expect((await service.listProfiles(f.owner)).find(item => item.id === profile.id)).toMatchObject({ name: "Shared", endpoint: "socks5h://old.example:1080" });
  });

  it("imports existing per-account proxies as private reusable profiles", async () => {
    const f = await fixture();
    await service.set(f.owner, f.account.id, "socks5h://alice:secret@proxy.example:1080");
    const profiles = await service.listProfiles(f.owner);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ endpoint: "socks5h://proxy.example:1080", assignedAccountIds: [f.account.id] });
    expect(JSON.stringify(profiles)).not.toContain("secret");
    expect(await service.listProfiles(f.owner)).toHaveLength(1);
  });

  it("checks a draft or saved profile without a cloud account and never returns its password", async () => {
    const f = await fixture();
    const profile = await service.createProfile(f.owner, { name: "Draft", proxyUrl: "socks5h://user:secret@proxy.example:1080" });
    expect(await service.checkDraft(f.owner, { proxyUrl: "socks5h://proxy2.example:1080" })).toMatchObject({ ok: true, ip: "203.0.113.9" });
    expect(await service.checkProfile(f.owner, profile.id)).toMatchObject({ ok: true, ip: "203.0.113.9" });
    expect(mocks.fetchCalls.map(call => call.url)).toEqual(["https://api64.ipify.org/?format=json", "https://api64.ipify.org/?format=json"]);
    expect(JSON.stringify(await connection.db.select().from(auditLogs).where(eq(auditLogs.resourceId, profile.id)))).not.toContain("secret");
    await expect(service.checkProfile(f.other, profile.id)).rejects.toMatchObject({ status: 404 });
  });

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
