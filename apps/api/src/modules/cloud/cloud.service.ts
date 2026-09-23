import { randomUUID } from "node:crypto";
import { getCloudRotationLimitStatus, getCloudTargetsForSlots, setCloudRotationLimitPolicy, wakeCloudRotationLimitWaits } from "@masterdns/db";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { auditLogs, cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, cloudScanScopes, instanceAuthorizations, managedAddressSlots, users } from "@masterdns/db";
import { CloudError, createCloudAdapter, evaluateCapabilities, credentialsMatchProvider, type CloudCredentials, type CloudInventory } from "@masterdns/cloud-providers";
import { cloudProviderServices, cloudRotationLimitPolicySchema, validCloudRegion, type CloudProvider, type CloudService as CloudServiceName, type SlotRef, type MonthlyTrafficResponse } from "@masterdns/contracts";
import { decryptJson, encryptJson, parseEncryptionKey } from "@masterdns/crypto";
import type { AuthUser } from "../../auth/auth.types.js";
import { env } from "../../config/env.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";
import { cloudRequestKey, withCloudRequest } from "./cloud-idempotency.js";
import type { CloudAuthorizationInput, CloudCredentialsUpdateInput, CreateCloudAccountInput } from "./cloud.schemas.js";

type Account = typeof cloudAccounts.$inferSelect;
export function publicCloudAccount(account: Account) {
  return { id: account.id, ownerUserId: account.ownerUserId, provider: account.provider, name: account.name, credentialHint: account.credentialHint, enabled: account.enabled, regions: account.regions, externalAccountId: account.externalAccountId, createdAt: account.createdAt, updatedAt: account.updatedAt };
}

@Injectable()
export class CloudService {
  private readonly encryptionKey = parseEncryptionKey(env.MASTER_ENCRYPTION_KEY);
  private readonly trafficCache = new Map<string, { expires: number; value: MonthlyTrafficResponse }>();
  private readonly trafficPending = new Map<string, Promise<MonthlyTrafficResponse>>();
  constructor(private readonly database: DatabaseService, private readonly queues: QueueService) {}

  async list(actor: AuthUser) {
    const accounts = await this.database.db.select().from(cloudAccounts).where(actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id)).orderBy(asc(cloudAccounts.createdAt));
    return accounts.map(publicCloudAccount);
  }

  async rotationLimits(actor: AuthUser, id: string, serviceName: string) {
    return this.database.db.transaction(async (tx) => {
      const [account] = await tx.select().from(cloudAccounts).where(and(eq(cloudAccounts.id, id), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id))).limit(1);
      if (!account) throw new NotFoundException("Cloud account not found");
      const service = this.rotationLimitService(account.provider, serviceName);
      if (!account.externalAccountId) throw new ConflictException("Cloud account identity must be verified before configuring rotation limits");
      return getCloudRotationLimitStatus(tx, account.id, service);
    });
  }

  async setRotationLimits(actor: AuthUser, id: string, serviceName: string, input: { utilizationPercent: number; enabled?: boolean }) {
    const { utilizationPercent, enabled } = cloudRotationLimitPolicySchema.parse(input);
    const result = await this.database.db.transaction(async (tx) => {
      const [account] = await tx.select().from(cloudAccounts).where(and(eq(cloudAccounts.id, id), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id))).for("update");
      if (!account) throw new NotFoundException("Cloud account not found");
      const service = this.rotationLimitService(account.provider, serviceName);
      if (!account.externalAccountId) throw new ConflictException("Cloud account identity must be verified before configuring rotation limits");
      const before = await getCloudRotationLimitStatus(tx, account.id, service);
      const after = await setCloudRotationLimitPolicy(tx, account.id, service, utilizationPercent, enabled);
      await tx.insert(auditLogs).values({
        ownerUserId: account.ownerUserId,
        actorUserId: actor.id,
        source: "user",
        action: "cloud_account.rotation_limit_policy",
        resourceType: "cloud_account",
        resourceId: account.id,
        beforeSnapshot: rotationLimitAuditSnapshot(before),
        afterSnapshot: rotationLimitAuditSnapshot(after),
      });
      return after;
    });
    if (enabled === false) await this.database.db.transaction(tx => wakeCloudRotationLimitWaits(tx, id, result.service));
    return result;
  }

  async create(actor: AuthUser, input: CreateCloudAccountInput, idempotencyKey: string) {
    const key = cloudRequestKey(idempotencyKey);
    const ownerUserId = input.ownerUserId ?? actor.id;
    if (actor.role !== "admin" && ownerUserId !== actor.id) throw new ForbiddenException("Cannot create an account for another user");
    this.assertCredentials(actor, input.credentials);
    if (!credentialsMatchProvider(input.provider, input.credentials)) throw new BadRequestException("Credentials do not match provider");
    this.assertRegions(input.provider, input.regions ?? null);
    const [owner] = await this.database.db.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).limit(1);
    if (!owner) throw new NotFoundException("Account owner not found");
    return this.database.db.transaction(async (tx) => {
      const result = await withCloudRequest(tx, {
        key, actorUserId: actor.id, ownerUserId, action: "account.create",
        request: { ...input, ownerUserId, regions: input.regions ? [...input.regions].sort() : null },
      }, async () => {
        const id = randomUUID();
        const { externalAccountId } = await createCloudAdapter({ accountId: id, provider: input.provider, service: cloudProviderServices[input.provider][0]!, credentials: input.credentials as CloudCredentials }).verifyIdentity();
        const [account] = await tx.insert(cloudAccounts).values({ id, ownerUserId, externalAccountId, name: input.name, provider: input.provider, regions: input.regions ?? null, ...this.encryptedCredentials(input.credentials) }).returning();
        if (!account) throw new Error("Cloud account insert returned no row");
        await tx.insert(auditLogs).values({ ownerUserId, actorUserId: actor.id, source: "user", action: "cloud_account.create", resourceType: "cloud_account", resourceId: account.id, afterSnapshot: publicCloudAccount(account) });
        return publicCloudAccount(account);
      });
      const [accessible] = await tx.select({ id: cloudAccounts.id }).from(cloudAccounts).where(and(eq(cloudAccounts.id, result.id), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id))).limit(1);
      if (!accessible) throw new NotFoundException("Cloud account not found");
      return result;
    });
  }

  async rotateCredentials(actor: AuthUser, id: string, input: CloudCredentialsUpdateInput) {
    this.assertCredentials(actor, input.credentials);
    const current = await this.findAccount(actor, id);
    if (!credentialsMatchProvider(current.provider, input.credentials)) throw new BadRequestException("Credentials do not match provider");
    const service = cloudProviderServices[current.provider][0]!;
    const expectedIdentity = current.externalAccountId ?? (await createCloudAdapter({ accountId: id, provider: current.provider, service, credentials: decryptJson<CloudCredentials>({ ciphertext: current.credentialCiphertext, iv: current.credentialIv, tag: current.credentialTag, keyVersion: current.credentialKeyVersion }, this.encryptionKey) }).verifyIdentity()).externalAccountId;
    const identity = await createCloudAdapter({ accountId: id, provider: current.provider, service, credentials: input.credentials as CloudCredentials }).verifyIdentity();
    if (identity.externalAccountId !== expectedIdentity) throw new ConflictException("Credentials belong to another cloud account; create a separate cloud account");
    return this.updateAccount(actor, id, { ...this.encryptedCredentials(input.credentials), externalAccountId: expectedIdentity }, "cloud_account.credentials_rotate", current.credentialCiphertext);
  }

  async setEnabled(actor: AuthUser, id: string, enabled: boolean) {
    return this.updateAccount(actor, id, { enabled }, "cloud_account.enabled");
  }

  async setRegions(actor: AuthUser, id: string, regions: string[] | null) {
    const account = await this.findAccount(actor, id);
    this.assertRegions(account.provider, regions);
    return this.updateAccount(actor, id, { regions }, "cloud_account.regions");
  }

  async sync(actor: AuthUser, id: string) {
    const account = await this.findAccount(actor, id);
    if (!account.enabled) throw new ConflictException("Cloud account is disabled");
    // One pending job per account; BullMQ removes it once complete, allowing a fresh sync.
    await this.queues.cloudSync.add("sync-cloud-account", { accountId: id }, { jobId: `cloud-sync-${id}`, removeOnComplete: true, removeOnFail: true });
    return { queued: true };
  }

  async scopes(actor: AuthUser, accountId: string) {
    await this.findAccount(actor, accountId);
    return this.database.db.select().from(cloudScanScopes).where(eq(cloudScanScopes.accountId, accountId)).orderBy(asc(cloudScanScopes.service), asc(cloudScanScopes.region));
  }

  async instances(actor: AuthUser, accountId: string) {
    const account = await this.findAccount(actor, accountId);
    const rows = await this.database.db.select({ instance: cloudInstances, authorization: instanceAuthorizations }).from(cloudInstances)
      .leftJoin(instanceAuthorizations, eq(instanceAuthorizations.instanceId, cloudInstances.id)).where(eq(cloudInstances.accountId, accountId)).orderBy(asc(cloudInstances.region), asc(cloudInstances.name));
    const addresses = await this.database.db.select({ instanceId: cloudInstances.id, address: cloudAddresses }).from(cloudAddresses)
      .innerJoin(cloudInterfaces, eq(cloudInterfaces.id, cloudAddresses.interfaceId))
      .innerJoin(cloudInstances, eq(cloudInstances.id, cloudInterfaces.instanceId))
      .where(and(eq(cloudInstances.accountId, accountId), eq(cloudInterfaces.scanGeneration, cloudInstances.scanGeneration), eq(cloudAddresses.scanGeneration, cloudInstances.scanGeneration), eq(cloudAddresses.kind, "host")));
    const byInstance = new Map<string, typeof cloudAddresses.$inferSelect[]>();
    for (const row of addresses) {
      const values = byInstance.get(row.instanceId) ?? [];
      values.push(row.address); byInstance.set(row.instanceId, values);
    }
    return rows.map((row) => ({ ...row, addresses: row.instance.metadata.present === false ? [] : byInstance.get(row.instance.id) ?? [], inScope: account.regions === null || account.regions.includes(row.instance.region) }));
  }

  async instance(actor: AuthUser, instanceId: string) {
    const [row] = await this.database.db.select({ instance: cloudInstances, authorization: instanceAuthorizations }).from(cloudInstances)
      .innerJoin(cloudAccounts, eq(cloudAccounts.id, cloudInstances.accountId))
      .leftJoin(instanceAuthorizations, eq(instanceAuthorizations.instanceId, cloudInstances.id))
      .where(and(eq(cloudInstances.id, instanceId), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id))).limit(1);
    if (!row) throw new NotFoundException("Cloud instance not found");
    const interfaces = await this.database.db.select().from(cloudInterfaces).where(eq(cloudInterfaces.instanceId, instanceId));
    const addresses = await this.database.db.select({ address: cloudAddresses }).from(cloudAddresses).innerJoin(cloudInterfaces, eq(cloudInterfaces.id, cloudAddresses.interfaceId)).where(eq(cloudInterfaces.instanceId, instanceId));
    const account = await this.findAccount(actor, row.instance.accountId);
    return { ...row, inScope: account.regions === null || account.regions.includes(row.instance.region), interfaces, addresses: addresses.map((entry) => entry.address) };
  }

  async slots(actor: AuthUser, instanceId: string) {
    const detail = await this.instance(actor, instanceId);
    const instance = detail.instance;
    const inventory: CloudInventory = {
      ref: { accountId: instance.accountId, service: instance.service, region: instance.region, instanceId: instance.externalId },
      name: instance.name ?? instance.externalId, state: instance.state ?? "unknown",
      metadata: providerMetadata(instance.metadata),
      ...(typeof instance.metadata.nativeName === "string" ? { nativeName: instance.metadata.nativeName } : {}),
      ...(typeof instance.metadata.ipv6Only === "boolean" ? { ipv6Only: instance.metadata.ipv6Only } : {}),
      interfaces: instance.metadata.present === false ? [] : detail.interfaces.filter((iface) => iface.scanGeneration === instance.scanGeneration).map((iface) => ({
        id: iface.externalId, metadata: providerMetadata(iface.metadata),
        ...(typeof iface.metadata.deviceIndex === "number" ? { deviceIndex: iface.metadata.deviceIndex } : {}),
        addresses: detail.addresses.filter((address) => address.interfaceId === iface.id && address.kind === "host" && address.scanGeneration === instance.scanGeneration).map((address) => ({
          metadata: providerMetadata(address.metadata),
          ...(typeof address.metadata.privateAddress === "string" ? { privateAddress: address.metadata.privateAddress } : {}),
          ...(typeof address.metadata.resourceId === "string" ? { resourceId: address.metadata.resourceId } : {}),
          address: address.address, family: address.family === "4" ? 4 : 6,
          primary: Array.isArray(iface.metadata.primaryAddresses) && iface.metadata.primaryAddresses.includes(address.address),
          ...(address.remoteAllocationId ? { allocationId: address.remoteAllocationId } : {}),
        })),
      })),
    };
    const rows = await this.database.db.select({ slot: managedAddressSlots, currentAddress: cloudAddresses, interfaceExternalId: cloudInterfaces.externalId }).from(managedAddressSlots)
      .innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId))
      .leftJoin(cloudAddresses, eq(cloudAddresses.id, managedAddressSlots.currentAddressId))
      .where(eq(cloudInterfaces.instanceId, instanceId));
    const targets = await getCloudTargetsForSlots(this.database.db, rows.map(row => row.slot.id));
    return rows.map(({ slot, currentAddress, interfaceExternalId }) => {
      const ref: SlotRef | null = currentAddress ? { ...inventory.ref, slotId: slot.id, interfaceId: interfaceExternalId, address: currentAddress.address, family: slot.family === "4" ? 4 : 6 } : null;
      return { slot, currentAddress, cloudTarget: targets.get(slot.id) ?? null, ref, capability: ref ? evaluateCapabilities(ref, inventory) : null, inScope: detail.inScope };
    });
  }

  async monthlyTraffic(actor: AuthUser, instanceId: string): Promise<MonthlyTrafficResponse> {
    // Authorize on every request, including cache hits. Read-only visibility does not
    // require instance management or rotation authorization.
    const { instance, inScope } = await this.instance(actor, instanceId);
    const account = await this.findAccount(actor, instance.accountId);
    if (!account.enabled) return { status: "unavailable", reason: "account_disabled" };
    if (!inScope) return { status: "unavailable", reason: "out_of_scope" };
    if (instance.metadata.present === false) return { status: "unavailable", reason: "resource_not_found" };
    const now = new Date();
    const key = `${instanceId}:${now.toISOString().slice(0, 7)}:${account.updatedAt.toISOString()}:${instance.updatedAt.toISOString()}`;
    const cached = this.trafficCache.get(key);
    if (cached && cached.expires > now.getTime()) return cached.value;
    const pending = this.trafficPending.get(key);
    if (pending) return pending;
    const query = async (): Promise<MonthlyTrafficResponse> => {
      try {
        const credentials = decryptJson<CloudCredentials>({ ciphertext: account.credentialCiphertext, iv: account.credentialIv, tag: account.credentialTag, keyVersion: account.credentialKeyVersion }, this.encryptionKey);
        const adapter = createCloudAdapter({ accountId: account.id, provider: account.provider, service: instance.service, credentials });
        const identity = await adapter.verifyIdentity();
        if (!account.externalAccountId || identity.externalAccountId !== account.externalAccountId) return { status: "unavailable", reason: "remote_identity_changed" };
        if (!adapter.monthlyTraffic) return { status: "unavailable", reason: "query_failed" };
        const traffic = await adapter.monthlyTraffic({ accountId: account.id, service: instance.service, region: instance.region, instanceId: instance.externalId }, now);
        const value: MonthlyTrafficResponse = { status: "available", traffic };
        for (const [entryKey, entry] of this.trafficCache) if (entry.expires <= Date.now()) this.trafficCache.delete(entryKey);
        if (this.trafficCache.size >= 1000) this.trafficCache.delete(this.trafficCache.keys().next().value!);
        this.trafficCache.set(key, { expires: Date.now() + 300_000, value });
        return value;
      } catch (error) {
        const reason = error instanceof CloudError ? error.code : "query_failed";
        switch (reason) {
          case "permission_denied": case "invalid_credentials": case "credentials_expired": case "rate_limited": case "resource_not_found": case "remote_identity_changed":
            return { status: "unavailable", reason };
          default: return { status: "unavailable", reason: "query_failed" };
        }
      }
    };
    const result = query();
    this.trafficPending.set(key, result);
    try { return await result; } finally { this.trafficPending.delete(key); }
  }

  async authorize(actor: AuthUser, instanceId: string, input: CloudAuthorizationInput) {
    // Account -> instance -> authorization is also the lock order used by scans and binding.
    const owned = await this.instance(actor, instanceId);
    return this.database.db.transaction(async (tx) => {
      const [account] = await tx.select().from(cloudAccounts).where(eq(cloudAccounts.id, owned.instance.accountId)).for("update");
      const [instance] = await tx.select().from(cloudInstances).where(eq(cloudInstances.id, instanceId)).for("update");
      if (!account || !instance) throw new NotFoundException("Cloud instance not found");
      if (input.managed && (!account.enabled || instance.metadata.present === false || (account.regions !== null && !account.regions.includes(instance.region)))) throw new ConflictException("Cloud instance is unavailable");
      const [before] = await tx.select().from(instanceAuthorizations).where(eq(instanceAuthorizations.instanceId, instanceId));
      if ((before?.revision ?? 0) !== input.revision) throw new ConflictException("Authorization revision has changed");
      const values = {
        managed: input.managed, revision: input.revision + 1,
        allowIpv4Rotation: input.managed && (input.allowIpv4Rotation ?? false),
        allowIpv6Rotation: input.managed && (input.allowIpv6Rotation ?? false),
        allowStopStart: input.managed && (input.allowStopStart ?? false),
        allowReleaseAddress: input.managed && (input.allowReleaseAddress ?? false),
        updatedByUserId: actor.id, updatedAt: new Date(),
      };
      const [after] = await tx.insert(instanceAuthorizations).values({ instanceId, ...values }).onConflictDoUpdate({ target: instanceAuthorizations.instanceId, set: values }).returning();
      await tx.insert(auditLogs).values({ ownerUserId: account.ownerUserId, actorUserId: actor.id, source: "user", action: "cloud_instance.authorize", resourceType: "cloud_instance", resourceId: instanceId, beforeSnapshot: before, afterSnapshot: after });
      return after!;
    });
  }

  private async findAccount(actor: AuthUser, id: string) {
    const [account] = await this.database.db.select().from(cloudAccounts).where(and(eq(cloudAccounts.id, id), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id))).limit(1);
    if (!account) throw new NotFoundException("Cloud account not found");
    return account;
  }

  private assertCredentials(actor: AuthUser, credentials: CreateCloudAccountInput["credentials"]) {
    if (credentials.kind === "role" && actor.role !== "admin") throw new ForbiddenException("Only administrators may configure deployment identities");
  }

  private assertRegions(provider: CloudProvider, regions: string[] | null) {
    if (regions !== null && (regions.length < 1 || regions.length > 100 || new Set(regions).size !== regions.length || regions.some(region => !validCloudRegion(provider, region)))) throw new BadRequestException("Invalid provider region");
  }

  private rotationLimitService(provider: CloudProvider, value: string): CloudServiceName {
    const service = cloudProviderServices[provider].find((candidate) => candidate === value);
    if (!service) throw new BadRequestException("Cloud service does not match account provider");
    return service;
  }

  private encryptedCredentials(credentials: CreateCloudAccountInput["credentials"]) {
    const encrypted = encryptJson(credentials, this.encryptionKey);
    return { credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag, credentialKeyVersion: encrypted.keyVersion, credentialHint: credentials.kind === "role" ? "Deployment identity" : credentials.kind === "access_key" ? `AccessKey ...${credentials.accessKeyId.slice(-4)}` : credentials.kind === "azure_service_principal" ? `Service principal ...${credentials.clientId.slice(-4)}` : "Linode API token" };
  }

  private async updateAccount(actor: AuthUser, id: string, fields: Partial<typeof cloudAccounts.$inferInsert>, action: string, expectedCredentialCiphertext?: string) {
    return this.database.db.transaction(async (tx) => {
      const [before] = await tx.select().from(cloudAccounts).where(and(eq(cloudAccounts.id, id), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id))).for("update");
      if (!before) throw new NotFoundException("Cloud account not found");
      if (expectedCredentialCiphertext !== undefined && before.credentialCiphertext !== expectedCredentialCiphertext) throw new ConflictException("Cloud credentials changed; retry verification");
      if (fields.externalAccountId !== undefined && before.externalAccountId !== null && before.externalAccountId !== fields.externalAccountId) throw new ConflictException("Cloud account identity changed during credential verification");
      const [after] = await tx.update(cloudAccounts).set({ ...fields, updatedAt: new Date() }).where(eq(cloudAccounts.id, id)).returning();
      await tx.insert(auditLogs).values({ ownerUserId: before.ownerUserId, actorUserId: actor.id, source: "user", action, resourceType: "cloud_account", resourceId: id, beforeSnapshot: publicCloudAccount(before), afterSnapshot: publicCloudAccount(after!) });
      return publicCloudAccount(after!);
    });
  }
}

function rotationLimitAuditSnapshot(status: { enabled?: boolean; service: CloudServiceName; utilizationPercent: number; effectivePercent: number }) {
  return { enabled: status.enabled ?? true, service: status.service, utilizationPercent: status.utilizationPercent, effectivePercent: status.effectivePercent };
}

function providerMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const value = metadata.providerMetadata;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
