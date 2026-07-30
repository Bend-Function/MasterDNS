import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { auditLogs, providerAccounts, users } from "@masterdns/db";
import { encryptJson, parseEncryptionKey } from "@masterdns/crypto";
import { createProviderAdapter, type ProviderCredentials } from "@masterdns/providers";
import type { AuthUser } from "../../auth/auth.types.js";
import { env } from "../../config/env.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";

type CreateAccountInput =
  | { name: string; ownerUserId?: string | undefined; provider: "cloudflare"; apiToken: string }
  | { name: string; ownerUserId?: string | undefined; provider: "aliyun"; accessKeyId: string; accessKeySecret: string; regionId?: string | undefined };
type RotateCredentialsInput =
  | { provider: "cloudflare"; apiToken: string }
  | { provider: "aliyun"; accessKeyId: string; accessKeySecret: string; regionId?: string | undefined };

@Injectable()
export class ProviderAccountsService {
  private readonly encryptionKey = parseEncryptionKey(env.MASTER_ENCRYPTION_KEY);

  constructor(private readonly database: DatabaseService, private readonly queues: QueueService) {}

  async list(actor: AuthUser) {
    const condition = actor.role === "admin" ? undefined : eq(providerAccounts.ownerUserId, actor.id);
    const rows = await this.database.db.select({ account: providerAccounts, ownerUsername: users.username })
      .from(providerAccounts).innerJoin(users, eq(providerAccounts.ownerUserId, users.id))
      .where(condition).orderBy(desc(providerAccounts.createdAt));
    return rows.map(({ account, ownerUsername }) => publicAccount(account, ownerUsername));
  }

  async create(actor: AuthUser, input: CreateAccountInput) {
    const ownerUserId = actor.role === "admin" && input.ownerUserId ? input.ownerUserId : actor.id;
    if (actor.role !== "admin" && input.ownerUserId && input.ownerUserId !== actor.id) throw new ForbiddenException("不能为其他用户创建云账号");
    if (actor.role === "admin" && input.ownerUserId) {
      const [owner] = await this.database.db.select({ id: users.id }).from(users).where(eq(users.id, input.ownerUserId)).limit(1);
      if (!owner) throw new NotFoundException("账号所有者不存在");
    }
    const credentials = providerCredentialsOnly(input);
    const adapter = createProviderAdapter(credentials);
    const capabilities = await adapter.verifyCredentials();
    const encrypted = encryptJson(credentials, this.encryptionKey);
    const [created] = await this.database.db.insert(providerAccounts).values({
      ownerUserId,
      provider: input.provider,
      name: input.name,
      credentialCiphertext: encrypted.ciphertext,
      credentialIv: encrypted.iv,
      credentialTag: encrypted.tag,
      credentialKeyVersion: encrypted.keyVersion,
      credentialHint: credentialHint(input),
      capabilities,
      status: "active",
      lastVerifiedAt: new Date(),
    }).returning();
    if (!created) throw new Error("Provider account insert returned no row");
    await this.database.db.insert(auditLogs).values({ ownerUserId, actorUserId: actor.id, source: "user", action: "provider_account.create", resourceType: "provider_account", resourceId: created.id, afterSnapshot: publicAccount(created) });
    await this.queues.sync.add("sync-provider-account", { providerAccountId: created.id }, { jobId: `provider-sync-${created.id}-${Date.now()}`, removeOnComplete: 100, removeOnFail: 500 });
    return publicAccount(created);
  }

  async sync(actor: AuthUser, id: string) {
    const account = await this.findOwned(actor, id);
    await this.queues.sync.add("sync-provider-account", { providerAccountId: account.id }, { jobId: `provider-sync-${account.id}-${Date.now()}`, removeOnComplete: 100, removeOnFail: 500 });
    return { queued: true };
  }

  async setStatus(actor: AuthUser, id: string, status: "active" | "disabled") {
    const current = await this.findOwned(actor, id);
    const [updated] = await this.database.db.update(providerAccounts).set({ status, updatedAt: new Date() }).where(eq(providerAccounts.id, id)).returning();
    if (!updated) throw new Error("Provider account update returned no row");
    await this.database.db.insert(auditLogs).values({ ownerUserId: current.ownerUserId, actorUserId: actor.id, source: "user", action: "provider_account.status", resourceType: "provider_account", resourceId: id, beforeSnapshot: publicAccount(current), afterSnapshot: publicAccount(updated) });
    return publicAccount(updated);
  }

  async rotateCredentials(actor: AuthUser, id: string, input: RotateCredentialsInput) {
    const current = await this.findOwned(actor, id);
    if (current.provider !== input.provider) throw new ForbiddenException("不能更改云账号的 Provider 类型");
    const credentials = providerCredentialsOnly(input);
    const capabilities = await createProviderAdapter(credentials).verifyCredentials();
    const encrypted = encryptJson(credentials, this.encryptionKey, current.credentialKeyVersion);
    const [updated] = await this.database.db.update(providerAccounts).set({
      credentialCiphertext: encrypted.ciphertext,
      credentialIv: encrypted.iv,
      credentialTag: encrypted.tag,
      credentialKeyVersion: encrypted.keyVersion,
      credentialHint: credentialHint(input),
      capabilities,
      status: "active",
      errorCode: null,
      lastVerifiedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(providerAccounts.id, id)).returning();
    if (!updated) throw new Error("Provider credential rotation returned no row");
    await this.database.db.insert(auditLogs).values({
      ownerUserId: current.ownerUserId,
      actorUserId: actor.id,
      source: "user",
      action: "provider_account.credentials_rotate",
      resourceType: "provider_account",
      resourceId: id,
      beforeSnapshot: publicAccount(current),
      afterSnapshot: publicAccount(updated),
    });
    await this.queues.sync.add("sync-provider-account", { providerAccountId: id }, { jobId: `provider-sync-${id}-${Date.now()}`, removeOnComplete: 100, removeOnFail: 500 });
    return publicAccount(updated);
  }

  private async findOwned(actor: AuthUser, id: string) {
    const condition = actor.role === "admin"
      ? eq(providerAccounts.id, id)
      : and(eq(providerAccounts.id, id), eq(providerAccounts.ownerUserId, actor.id));
    const [account] = await this.database.db.select().from(providerAccounts).where(condition).limit(1);
    if (!account) throw new NotFoundException("云账号不存在");
    return account;
  }
}

function providerCredentialsOnly(input: CreateAccountInput | RotateCredentialsInput): ProviderCredentials {
  if (input.provider === "cloudflare") return { provider: "cloudflare", apiToken: input.apiToken };
  return { provider: "aliyun", accessKeyId: input.accessKeyId, accessKeySecret: input.accessKeySecret, ...(input.regionId ? { regionId: input.regionId } : {}) };
}

function credentialHint(input: CreateAccountInput | RotateCredentialsInput): string {
  if (input.provider === "cloudflare") return "API Token";
  return `AccessKey ...${input.accessKeyId.slice(-4)}`;
}

function publicAccount(account: typeof providerAccounts.$inferSelect, ownerUsername?: string) {
  return {
    id: account.id,
    ownerUserId: account.ownerUserId,
    ownerUsername,
    provider: account.provider,
    name: account.name,
    credentialHint: account.credentialHint,
    capabilities: account.capabilities,
    status: account.status,
    errorCode: account.errorCode,
    lastVerifiedAt: account.lastVerifiedAt,
    lastSyncedAt: account.lastSyncedAt,
    createdAt: account.createdAt,
  };
}
