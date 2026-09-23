import { isIP } from "node:net";
import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { auditLogs, cloudAccounts } from "@masterdns/db";
import { createCloudAdapter, createCloudFetch, parseCloudProxyUrl, proxyEndpoint, type CloudCredentials } from "@masterdns/cloud-providers";
import { cloudProviderServices } from "@masterdns/contracts";
import { decryptJson, encryptJson, parseEncryptionKey } from "@masterdns/crypto";

import type { AuthUser } from "../../auth/auth.types.js";
import { env } from "../../config/env.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";
import { cloudProxyCheckSchema, type CloudProxyCheckInput, type CloudProxyCheckResult, type CloudProxyStatus } from "./cloud-proxy.js";

const IP_CHECK_URL = "https://api64.ipify.org/?format=json";
const MAX_CHECK_BODY_BYTES = 64 * 1024;

@Injectable()
export class CloudProxyService {
  private readonly encryptionKey = parseEncryptionKey(env.MASTER_ENCRYPTION_KEY);
  constructor(private readonly database: DatabaseService, private readonly queues: QueueService) {}

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
      await tx.update(cloudAccounts).set({ credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag, credentialKeyVersion: encrypted.keyVersion, externalAccountId: current.externalAccountId ?? identity.externalAccountId, updatedAt: new Date() }).where(eq(cloudAccounts.id, id));
      await tx.insert(auditLogs).values({ ownerUserId: locked.ownerUserId, actorUserId: actor.id, source: "user", action: "cloud_account.proxy", resourceType: "cloud_account", resourceId: id, beforeSnapshot: { configured: before.configured }, afterSnapshot: { configured: after.configured } });
      return after;
    });
  }

  async check(actor: AuthUser, id: string, rawInput: CloudProxyCheckInput): Promise<CloudProxyCheckResult> {
    const account = await this.findAccount(actor, id);
    const input = cloudProxyCheckSchema.parse(rawInput);
    const count = await this.queues.incrementRateLimit(`masterdns:rate:cloud-proxy-check:${actor.id}:${id}`, 60_000);
    if (count > 6) throw new HttpException("Too many proxy checks", HttpStatus.TOO_MANY_REQUESTS);
    const proxyUrl = input.proxyUrl ?? this.decrypt(account).proxyUrl;
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
