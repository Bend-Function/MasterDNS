import { isIP } from "node:net";
import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { auditLogs, cloudAccounts, cloudProxyProfiles, users } from "@masterdns/db";
import { createCloudAdapter, createCloudFetch, parseCloudProxyUrl, proxyEndpoint, type CloudCredentials } from "@masterdns/cloud-providers";
import { cloudProviderServices } from "@masterdns/contracts";
import { decryptJson, encryptJson, parseEncryptionKey } from "@masterdns/crypto";

import type { AuthUser } from "../../auth/auth.types.js";
import { env } from "../../config/env.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";
import { cloudProxyCheckSchema, type CloudProxyCheckInput, type CloudProxyCheckResult, type CloudProxyStatus, type CloudProxyProfileInput, type CloudProxyProfileUpdateInput } from "./cloud-proxy.js";

const IP_CHECK_URL = "https://api64.ipify.org/?format=json";
const MAX_CHECK_BODY_BYTES = 64 * 1024;

@Injectable()
export class CloudProxyService {
  private readonly encryptionKey = parseEncryptionKey(env.MASTER_ENCRYPTION_KEY);
  constructor(private readonly database: DatabaseService, private readonly queues: QueueService) {}

  async listProfiles(actor: AuthUser) {
    await this.importLegacyProxies(actor);
    const profiles = await this.database.db.select().from(cloudProxyProfiles).where(actor.role === "admin" ? undefined : eq(cloudProxyProfiles.ownerUserId, actor.id)).orderBy(asc(cloudProxyProfiles.createdAt));
    const accounts = await this.database.db.select({ id: cloudAccounts.id, proxyProfileId: cloudAccounts.proxyProfileId }).from(cloudAccounts).where(actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id));
    return profiles.map(profile => this.publicProfile(profile, accounts.filter(account => account.proxyProfileId === profile.id).map(account => account.id)));
  }

  async createProfile(actor: AuthUser, input: CloudProxyProfileInput) {
    if (input.ownerUserId && actor.role !== "admin" && input.ownerUserId !== actor.id) throw new NotFoundException("Proxy owner not found");
    const ownerUserId = actor.role === "admin" ? input.ownerUserId ?? actor.id : actor.id;
    const [owner] = await this.database.db.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).limit(1);
    if (!owner) throw new NotFoundException("Proxy owner not found");
    try { parseCloudProxyUrl(input.proxyUrl); }
    catch { throw new BadRequestException("Invalid SOCKS proxy URL"); }
    return this.database.db.transaction(async tx => {
      const [profile] = await tx.insert(cloudProxyProfiles).values({ ownerUserId, name: input.name, ...this.encryptUrl(input.proxyUrl) }).returning();
      await tx.insert(auditLogs).values({ ownerUserId, actorUserId: actor.id, source: "user", action: "cloud_proxy.create", resourceType: "cloud_proxy", resourceId: profile!.id, afterSnapshot: { name: profile!.name, endpoint: proxyEndpoint(input.proxyUrl) } });
      return this.publicProfile(profile!, []);
    });
  }

  async updateProfile(actor: AuthUser, id: string, input: CloudProxyProfileUpdateInput) {
    return this.database.db.transaction(async tx => {
      const [profile] = await tx.select().from(cloudProxyProfiles).where(and(eq(cloudProxyProfiles.id, id), actor.role === "admin" ? undefined : eq(cloudProxyProfiles.ownerUserId, actor.id))).for("update");
      if (!profile) throw new NotFoundException("Proxy profile not found");
      const accounts = await tx.select().from(cloudAccounts).where(eq(cloudAccounts.proxyProfileId, id)).orderBy(asc(cloudAccounts.id)).for("update");
      const nextUrl = input.proxyUrl ?? this.decryptUrl(profile);
      if (input.proxyUrl !== undefined) {
        try { parseCloudProxyUrl(input.proxyUrl); }
        catch { throw new BadRequestException("Invalid SOCKS proxy URL"); }
        for (const account of accounts) {
          const credentials = this.decrypt(account);
          const candidate = { ...credentials, proxyUrl: nextUrl } as CloudCredentials;
          const identity = await createCloudAdapter({ accountId: account.id, provider: account.provider, service: cloudProviderServices[account.provider][0]!, credentials: candidate }).verifyIdentity();
          if (account.externalAccountId && identity.externalAccountId !== account.externalAccountId) throw new ConflictException("Proxy route reached another cloud account");
        }
        for (const account of accounts) {
          const encrypted = encryptJson({ ...this.decrypt(account), proxyUrl: nextUrl }, this.encryptionKey);
          await tx.update(cloudAccounts).set({ credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag, credentialKeyVersion: encrypted.keyVersion, updatedAt: new Date() }).where(eq(cloudAccounts.id, account.id));
        }
      }
      const [updated] = await tx.update(cloudProxyProfiles).set({ name: input.name, ...(input.proxyUrl === undefined ? {} : this.encryptUrl(nextUrl)), updatedAt: new Date() }).where(eq(cloudProxyProfiles.id, id)).returning();
      await tx.insert(auditLogs).values({ ownerUserId: profile.ownerUserId, actorUserId: actor.id, source: "user", action: "cloud_proxy.update", resourceType: "cloud_proxy", resourceId: id, beforeSnapshot: { name: profile.name, endpoint: proxyEndpoint(this.decryptUrl(profile)) }, afterSnapshot: { name: updated!.name, endpoint: proxyEndpoint(nextUrl) } });
      return this.publicProfile(updated!, accounts.map(account => account.id));
    });
  }

  async deleteProfile(actor: AuthUser, id: string) {
    return this.database.db.transaction(async tx => {
      const [profile] = await tx.select().from(cloudProxyProfiles).where(and(eq(cloudProxyProfiles.id, id), actor.role === "admin" ? undefined : eq(cloudProxyProfiles.ownerUserId, actor.id))).for("update");
      if (!profile) throw new NotFoundException("Proxy profile not found");
      const [account] = await tx.select({ id: cloudAccounts.id }).from(cloudAccounts).where(eq(cloudAccounts.proxyProfileId, id)).limit(1);
      if (account) throw new ConflictException("Proxy is used by cloud accounts; select another proxy first");
      await tx.delete(cloudProxyProfiles).where(eq(cloudProxyProfiles.id, id));
      await tx.insert(auditLogs).values({ ownerUserId: profile.ownerUserId, actorUserId: actor.id, source: "user", action: "cloud_proxy.delete", resourceType: "cloud_proxy", resourceId: id, beforeSnapshot: { name: profile.name, endpoint: proxyEndpoint(this.decryptUrl(profile)) } });
      return { deleted: true };
    });
  }

  async selectProfile(actor: AuthUser, accountId: string, profileId: string | null) {
    const current = await this.findAccount(actor, accountId);
    const profile = profileId === null ? null : await this.findProfile(actor, profileId, current.ownerUserId);
    const credentials = this.decrypt(current);
    const { proxyUrl: _previous, ...baseCredentials } = credentials;
    const candidate = { ...baseCredentials, ...(profile ? { proxyUrl: this.decryptUrl(profile) } : {}) } as CloudCredentials;
    const identity = await createCloudAdapter({ accountId, provider: current.provider, service: cloudProviderServices[current.provider][0]!, credentials: candidate }).verifyIdentity();
    if (current.externalAccountId && identity.externalAccountId !== current.externalAccountId) throw new ConflictException("Proxy route reached another cloud account");
    return this.database.db.transaction(async tx => {
      if (profile) {
        const [lockedProfile] = await tx.select().from(cloudProxyProfiles).where(eq(cloudProxyProfiles.id, profile.id)).for("share");
        if (!lockedProfile || lockedProfile.ownerUserId !== current.ownerUserId || lockedProfile.credentialCiphertext !== profile.credentialCiphertext) throw new ConflictException("Proxy profile changed; retry selection");
      }
      const [locked] = await tx.select().from(cloudAccounts).where(and(eq(cloudAccounts.id, accountId), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id))).for("update");
      if (!locked || locked.ownerUserId !== current.ownerUserId || locked.credentialCiphertext !== current.credentialCiphertext || locked.externalAccountId !== current.externalAccountId || locked.proxyProfileId !== current.proxyProfileId) throw new ConflictException("Cloud account changed; retry selection");
      const encrypted = encryptJson(candidate, this.encryptionKey);
      const [updated] = await tx.update(cloudAccounts).set({ credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag, credentialKeyVersion: encrypted.keyVersion, proxyProfileId: profileId, externalAccountId: current.externalAccountId ?? identity.externalAccountId, updatedAt: new Date() }).where(eq(cloudAccounts.id, accountId)).returning();
      await tx.insert(auditLogs).values({ ownerUserId: locked.ownerUserId, actorUserId: actor.id, source: "user", action: "cloud_account.proxy_select", resourceType: "cloud_account", resourceId: accountId, beforeSnapshot: { proxyProfileId: locked.proxyProfileId }, afterSnapshot: { proxyProfileId: profileId } });
      return { proxyProfileId: updated!.proxyProfileId, configured: !!profileId, endpoint: profile ? proxyEndpoint(this.decryptUrl(profile)) : null };
    });
  }

  async checkProfile(actor: AuthUser, id: string): Promise<CloudProxyCheckResult> {
    const profile = await this.findProfile(actor, id);
    return this.probe(actor.id, id, this.decryptUrl(profile));
  }

  async checkDraft(actor: AuthUser, input: CloudProxyCheckInput): Promise<CloudProxyCheckResult> {
    if (!input.proxyUrl) throw new BadRequestException("Proxy URL is required");
    try { parseCloudProxyUrl(input.proxyUrl); }
    catch { throw new BadRequestException("Invalid SOCKS proxy URL"); }
    return this.probe(actor.id, "draft", input.proxyUrl);
  }

  async get(actor: AuthUser, id: string): Promise<CloudProxyStatus> {
    const account = await this.findAccount(actor, id);
    return proxyStatus(this.decrypt(account).proxyUrl);
  }

  async set(actor: AuthUser, id: string, proxyUrl: string | null): Promise<CloudProxyStatus> {
    if (proxyUrl !== null) {
      try { parseCloudProxyUrl(proxyUrl); }
      catch { throw new BadRequestException("Invalid SOCKS proxy URL"); }
    }
    const current = await this.findAccount(actor, id);
    const credentials = this.decrypt(current);
    const { proxyUrl: _previousProxy, ...withoutProxy } = credentials;
    const candidate = (proxyUrl === null ? withoutProxy : { ...withoutProxy, proxyUrl }) as CloudCredentials;
    const service = cloudProviderServices[current.provider][0]!;
    const identity = await createCloudAdapter({ accountId: id, provider: current.provider, service, credentials: candidate }).verifyIdentity();
    if (current.externalAccountId !== null && identity.externalAccountId !== current.externalAccountId) throw new ConflictException("Proxy route reached another cloud account");
    const encrypted = encryptJson(candidate, this.encryptionKey);
    return this.database.db.transaction(async tx => {
      const [locked] = await tx.select().from(cloudAccounts).where(and(eq(cloudAccounts.id, id), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id))).for("update");
      if (!locked) throw new NotFoundException("Cloud account not found");
      if (locked.ownerUserId !== current.ownerUserId || locked.provider !== current.provider || locked.externalAccountId !== current.externalAccountId
        || locked.credentialCiphertext !== current.credentialCiphertext || locked.credentialIv !== current.credentialIv
        || locked.credentialTag !== current.credentialTag || locked.credentialKeyVersion !== current.credentialKeyVersion) {
        throw new ConflictException("Cloud account changed during proxy verification");
      }
      const before = proxyStatus(credentials.proxyUrl);
      const after = proxyStatus(candidate.proxyUrl);
      await tx.update(cloudAccounts).set({ credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag, credentialKeyVersion: encrypted.keyVersion, proxyProfileId: null, externalAccountId: current.externalAccountId ?? identity.externalAccountId, updatedAt: new Date() }).where(eq(cloudAccounts.id, id));
      await tx.insert(auditLogs).values({ ownerUserId: locked.ownerUserId, actorUserId: actor.id, source: "user", action: "cloud_account.proxy", resourceType: "cloud_account", resourceId: id, beforeSnapshot: { configured: before.configured }, afterSnapshot: { configured: after.configured } });
      return after;
    });
  }

  async check(actor: AuthUser, id: string, rawInput: CloudProxyCheckInput): Promise<CloudProxyCheckResult> {
    const account = await this.findAccount(actor, id);
    const input = cloudProxyCheckSchema.parse(rawInput);
    return this.probe(actor.id, id, input.proxyUrl ?? this.decrypt(account).proxyUrl);
  }

  private async probe(actorId: string, scopeId: string, proxyUrl?: string): Promise<CloudProxyCheckResult> {
    const count = await this.queues.incrementRateLimit(`masterdns:rate:cloud-proxy-check:${actorId}:${scopeId}`, 60_000);
    if (count > 6) throw new HttpException("Too many proxy checks", HttpStatus.TOO_MANY_REQUESTS);
    const started = Date.now();
    const base = () => ({ checkedAt: new Date().toISOString(), latencyMs: Math.max(0, Date.now() - started) });
    if (proxyUrl === undefined) return { ok: false, ip: null, ...base(), error: "proxy_not_configured" };
    try {
      const response = await createCloudFetch(proxyUrl)(IP_CHECK_URL, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      if (response.status < 200 || response.status >= 300) return { ok: false, ip: null, ...base(), error: "ip_service_unavailable" };
      let raw: string;
      try { raw = await readBoundedBody(response, MAX_CHECK_BODY_BYTES); }
      catch { return { ok: false, ip: null, ...base(), error: "ip_service_invalid_response" }; }
      let body: unknown;
      try { body = JSON.parse(raw); }
      catch { return { ok: false, ip: null, ...base(), error: "ip_service_invalid_response" }; }
      const ip = typeof body === "object" && body !== null && "ip" in body ? (body as { ip?: unknown }).ip : undefined;
      if (typeof ip !== "string" || isIP(ip) === 0) return { ok: false, ip: null, ...base(), error: "ip_service_invalid_response" };
      return { ok: true, ip, ...base(), error: null };
    } catch (error) {
      const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
      return { ok: false, ip: null, ...base(), error: name === "AbortError" || name === "TimeoutError" ? "proxy_timeout" : "proxy_connection_failed" };
    }
  }

  private async findProfile(actor: AuthUser, id: string, ownerUserId?: string) {
    const [profile] = await this.database.db.select().from(cloudProxyProfiles).where(and(eq(cloudProxyProfiles.id, id), actor.role === "admin" ? undefined : eq(cloudProxyProfiles.ownerUserId, actor.id), ownerUserId ? eq(cloudProxyProfiles.ownerUserId, ownerUserId) : undefined)).limit(1);
    if (!profile) throw new NotFoundException("Proxy profile not found");
    return profile;
  }

  private encryptUrl(proxyUrl: string) {
    const encrypted = encryptJson({ proxyUrl }, this.encryptionKey);
    return { credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag, credentialKeyVersion: encrypted.keyVersion };
  }

  private decryptUrl(profile: typeof cloudProxyProfiles.$inferSelect): string {
    return decryptJson<{ proxyUrl: string }>({ ciphertext: profile.credentialCiphertext, iv: profile.credentialIv, tag: profile.credentialTag, keyVersion: profile.credentialKeyVersion }, this.encryptionKey).proxyUrl;
  }

  private publicProfile(profile: typeof cloudProxyProfiles.$inferSelect, assignedAccountIds: string[]) {
    return { id: profile.id, ownerUserId: profile.ownerUserId, name: profile.name, endpoint: proxyEndpoint(this.decryptUrl(profile)), assignedAccountIds, createdAt: profile.createdAt, updatedAt: profile.updatedAt };
  }

  private async importLegacyProxies(actor: AuthUser) {
    await this.database.db.transaction(async tx => {
      const accounts = await tx.select().from(cloudAccounts).where(and(actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id), isNull(cloudAccounts.proxyProfileId))).orderBy(asc(cloudAccounts.id)).for("update");
      for (const account of accounts) {
        let proxyUrl: string | undefined;
        try { proxyUrl = this.decrypt(account).proxyUrl; }
        catch { continue; }
        if (!proxyUrl) continue;
        const [profile] = await tx.insert(cloudProxyProfiles).values({ ownerUserId: account.ownerUserId, name: `${account.name} · 已迁移代理`.slice(0, 120), ...this.encryptUrl(proxyUrl) }).returning();
        await tx.update(cloudAccounts).set({ proxyProfileId: profile!.id }).where(eq(cloudAccounts.id, account.id));
      }
    });
  }

  private async findAccount(actor: AuthUser, id: string) {
    const [account] = await this.database.db.select().from(cloudAccounts).where(and(eq(cloudAccounts.id, id), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id))).limit(1);
    if (!account) throw new NotFoundException("Cloud account not found");
    return account;
  }

  private decrypt(account: typeof cloudAccounts.$inferSelect): CloudCredentials {
    return decryptJson<CloudCredentials>({ ciphertext: account.credentialCiphertext, iv: account.credentialIv, tag: account.credentialTag, keyVersion: account.credentialKeyVersion }, this.encryptionKey);
  }
}

function proxyStatus(proxyUrl?: string): CloudProxyStatus {
  return proxyUrl === undefined ? { configured: false, endpoint: null } : { configured: true, endpoint: proxyEndpoint(proxyUrl) };
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) throw new Error("response_too_large");
  if (response.body === null) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk); total += buffer.length;
    if (total > limit) throw new Error("response_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
