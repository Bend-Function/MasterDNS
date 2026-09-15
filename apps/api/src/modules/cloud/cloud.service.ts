import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { auditLogs, cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, cloudScanScopes, instanceAuthorizations, managedAddressSlots, users } from "@masterdns/db";
import { createCloudAdapter, evaluateCapabilities, type AwsCredentials, type CloudInventory } from "@masterdns/cloud-providers";
import type { SlotRef } from "@masterdns/contracts";
import { decryptJson, encryptJson, parseEncryptionKey } from "@masterdns/crypto";
import type { AuthUser } from "../../auth/auth.types.js";
import { env } from "../../config/env.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";
import type { CloudAuthorizationInput, CloudCredentialsUpdateInput, CreateCloudAccountInput } from "./cloud.schemas.js";

type Account = typeof cloudAccounts.$inferSelect;
export function publicCloudAccount(account: Account) {
  return { id: account.id, ownerUserId: account.ownerUserId, provider: account.provider, name: account.name, credentialHint: account.credentialHint, enabled: account.enabled, regions: account.regions, externalAccountId: account.externalAccountId, createdAt: account.createdAt, updatedAt: account.updatedAt };
}

@Injectable()
export class CloudService {
  private readonly encryptionKey = parseEncryptionKey(env.MASTER_ENCRYPTION_KEY);
  constructor(private readonly database: DatabaseService, private readonly queues: QueueService) {}

  async list(actor: AuthUser) {
    const accounts = await this.database.db.select().from(cloudAccounts).where(actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id)).orderBy(asc(cloudAccounts.createdAt));
    return accounts.map(publicCloudAccount);
  }

  async create(actor: AuthUser, input: CreateCloudAccountInput) {
    const ownerUserId = input.ownerUserId ?? actor.id;
    if (actor.role !== "admin" && ownerUserId !== actor.id) throw new ForbiddenException("Cannot create an account for another user");
    this.assertCredentials(actor, input.credentials);
    const [owner] = await this.database.db.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).limit(1);
    if (!owner) throw new NotFoundException("Account owner not found");
    const id = randomUUID();
    const { externalAccountId } = await createCloudAdapter({ accountId: id, service: "ec2", credentials: input.credentials as AwsCredentials }).verifyIdentity();
    return this.database.db.transaction(async (tx) => {
      const [account] = await tx.insert(cloudAccounts).values({ id, ownerUserId, externalAccountId, name: input.name, provider: input.provider, regions: input.regions ?? null, ...this.encryptedCredentials(input.credentials) }).returning();
      if (!account) throw new Error("Cloud account insert returned no row");
      await tx.insert(auditLogs).values({ ownerUserId, actorUserId: actor.id, source: "user", action: "cloud_account.create", resourceType: "cloud_account", resourceId: account.id, afterSnapshot: publicCloudAccount(account) });
      return publicCloudAccount(account);
    });
  }

  async rotateCredentials(actor: AuthUser, id: string, input: CloudCredentialsUpdateInput) {
    this.assertCredentials(actor, input.credentials);
    const current = await this.findAccount(actor, id);
    const expectedIdentity = current.externalAccountId ?? (await createCloudAdapter({ accountId: id, service: "ec2", credentials: decryptJson<AwsCredentials>({ ciphertext: current.credentialCiphertext, iv: current.credentialIv, tag: current.credentialTag, keyVersion: current.credentialKeyVersion }, this.encryptionKey) }).verifyIdentity()).externalAccountId;
    const identity = await createCloudAdapter({ accountId: id, service: "ec2", credentials: input.credentials as AwsCredentials }).verifyIdentity();
    if (identity.externalAccountId !== expectedIdentity) throw new ConflictException("Credentials belong to another AWS account; create a separate cloud account");
    return this.updateAccount(actor, id, { ...this.encryptedCredentials(input.credentials), externalAccountId: expectedIdentity }, "cloud_account.credentials_rotate", current.credentialCiphertext);
  }

  async setEnabled(actor: AuthUser, id: string, enabled: boolean) {
    return this.updateAccount(actor, id, { enabled }, "cloud_account.enabled");
  }

  async setRegions(actor: AuthUser, id: string, regions: string[] | null) {
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
    return rows.map((row) => ({ ...row, inScope: account.regions === null || account.regions.includes(row.instance.region) }));
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
      ...(typeof instance.metadata.nativeName === "string" ? { nativeName: instance.metadata.nativeName } : {}),
      ...(typeof instance.metadata.ipv6Only === "boolean" ? { ipv6Only: instance.metadata.ipv6Only } : {}),
      interfaces: instance.metadata.present === false ? [] : detail.interfaces.filter((iface) => iface.scanGeneration === instance.scanGeneration).map((iface) => ({
        id: iface.externalId,
        ...(typeof iface.metadata.deviceIndex === "number" ? { deviceIndex: iface.metadata.deviceIndex } : {}),
        addresses: detail.addresses.filter((address) => address.interfaceId === iface.id && address.kind === "host" && address.scanGeneration === instance.scanGeneration).map((address) => ({
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
    return rows.map(({ slot, currentAddress, interfaceExternalId }) => {
      const ref: SlotRef | null = currentAddress ? { ...inventory.ref, slotId: slot.id, interfaceId: interfaceExternalId, address: currentAddress.address, family: slot.family === "4" ? 4 : 6 } : null;
      return { slot, currentAddress, ref, capability: ref ? evaluateCapabilities(ref, inventory) : null, inScope: detail.inScope };
    });
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

  private encryptedCredentials(credentials: CreateCloudAccountInput["credentials"]) {
    const encrypted = encryptJson(credentials, this.encryptionKey);
    return { credentialCiphertext: encrypted.ciphertext, credentialIv: encrypted.iv, credentialTag: encrypted.tag, credentialKeyVersion: encrypted.keyVersion, credentialHint: credentials.kind === "role" ? "Deployment identity" : `AccessKey ...${credentials.accessKeyId.slice(-4)}` };
  }

  private async updateAccount(actor: AuthUser, id: string, fields: Partial<typeof cloudAccounts.$inferInsert>, action: string, expectedCredentialCiphertext?: string) {
    return this.database.db.transaction(async (tx) => {
      const [before] = await tx.select().from(cloudAccounts).where(and(eq(cloudAccounts.id, id), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id))).for("update");
      if (!before) throw new NotFoundException("Cloud account not found");
      if (expectedCredentialCiphertext !== undefined && before.credentialCiphertext !== expectedCredentialCiphertext) throw new ConflictException("Cloud credentials changed; retry verification");
      const [after] = await tx.update(cloudAccounts).set({ ...fields, updatedAt: new Date() }).where(eq(cloudAccounts.id, id)).returning();
      await tx.insert(auditLogs).values({ ownerUserId: before.ownerUserId, actorUserId: actor.id, source: "user", action, resourceType: "cloud_account", resourceId: id, beforeSnapshot: publicCloudAccount(before), afterSnapshot: publicCloudAccount(after!) });
      return publicCloudAccount(after!);
    });
  }
}
