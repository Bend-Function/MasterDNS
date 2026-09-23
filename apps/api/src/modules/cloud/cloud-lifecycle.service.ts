import { createHash } from "node:crypto";
import { ConflictException, Injectable, NotFoundException, ForbiddenException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { auditLogs, cloudAccounts, lifecycleTrafficPolicies, cloudCredentialFingerprint, cloudInstances, cloudInstanceControls, cloudLifecycleOperations, cloudTrafficStopPolicies, lifecycleActiveStatuses, lifecycleActorAuthorized, lifecycleAuthorizationError, lifecycleDeleteProtection, lockCloudLifecycleContext, publicLifecycleOperation, publicTrafficPolicy, trafficStopUsage } from "@masterdns/db";
import { createCloudAdapter, type CloudCredentials } from "@masterdns/cloud-providers";
import { decryptJson, parseEncryptionKey } from "@masterdns/crypto";
import { cloudLifecycleActionSchema, cloudTrafficStopPolicySchema, type CloudLifecycleActionInput, type CloudInstanceControlView, type CloudTrafficStopPolicyInput } from "@masterdns/contracts";
import type { AuthUser } from "../../auth/auth.types.js";
import { env } from "../../config/env.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { cloudRequestKey } from "./cloud-idempotency.js";

@Injectable()
export class CloudLifecycleService {
  private readonly encryptionKey = parseEncryptionKey(env.MASTER_ENCRYPTION_KEY);
  constructor(private readonly database: DatabaseService) {}
  private async owned(actor: AuthUser, instanceId: string) {
    const [row] = await this.database.db.select({ instance: cloudInstances, account: cloudAccounts }).from(cloudInstances).innerJoin(cloudAccounts, eq(cloudAccounts.id, cloudInstances.accountId)).where(and(eq(cloudInstances.id, instanceId), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id)));
    if (!row) throw new NotFoundException("Cloud instance not found");
    return row;
  }
  async control(actor: AuthUser, instanceId: string): Promise<CloudInstanceControlView> {
    await this.owned(actor, instanceId);
    return this.database.db.transaction(async tx => {
      const c = await lockCloudLifecycleContext(tx, instanceId);
      if (!await lifecycleActorAuthorized(tx, actor.id, c.account.ownerUserId)) throw new NotFoundException("Cloud instance not found");
      const [policy] = await tx.select().from(cloudTrafficStopPolicies).where(eq(cloudTrafficStopPolicies.instanceId, instanceId));
      const operations = await tx.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.instanceId, instanceId)).orderBy(desc(cloudLifecycleOperations.createdAt)).limit(30);
      const [control] = await tx.select().from(cloudInstanceControls).where(eq(cloudInstanceControls.physicalKey, c.physicalKey));
      const [pending] = await tx.select().from(cloudLifecycleOperations).where(and(eq(cloudLifecycleOperations.physicalKey, c.physicalKey), inArray(cloudLifecycleOperations.status, [...lifecycleActiveStatuses]))).limit(1);
      const blockReason = pending ? "lifecycle_pending" : c.lease.unresolvedStepId || (c.lease.holder && c.lease.expiresAt > new Date()) ? "rotation_in_progress" : null;
      return { policy: publicTrafficPolicy(instanceId, policy), operations: operations.map(publicLifecycleOperation), blocked: !!blockReason, blockReason, powerHold: control?.powerHold ?? null };
    });
  }
  async setTrafficPolicy(actor: AuthUser, instanceId: string, body: CloudTrafficStopPolicyInput) {
    const input = cloudTrafficStopPolicySchema.parse(body);
    const owned = await this.owned(actor, instanceId);
    let resourceIdentity: string | undefined;
    if (input.enabled) {
      await this.database.db.transaction(async tx => {
        const c = await lockCloudLifecycleContext(tx, instanceId);
        if (!await lifecycleActorAuthorized(tx, actor.id, c.account.ownerUserId) || lifecycleAuthorizationError(c, "stop")) throw new ForbiddenException("Stopping this instance is not authorized");
      });
      const account = owned.account;
      const credentials = decryptJson<CloudCredentials>({ ciphertext: account.credentialCiphertext, iv: account.credentialIv, tag: account.credentialTag, keyVersion: account.credentialKeyVersion }, this.encryptionKey);
      const adapter = createCloudAdapter({ accountId: account.id, provider: account.provider, service: owned.instance.service, credentials });
      if ((await adapter.verifyIdentity()).externalAccountId !== account.externalAccountId) throw new ConflictException("remote_identity_changed");
      if (!adapter.inspectLifecycle) throw new ConflictException("lifecycle_unsupported");
      const snapshot = await adapter.inspectLifecycle({ accountId: account.id, service: owned.instance.service, region: owned.instance.region, instanceId: owned.instance.externalId });
      if (!snapshot.identity || snapshot.state === "deleted") throw new ConflictException("resource_not_found");
      resourceIdentity = snapshot.identity;
    }
    return this.database.db.transaction(async tx => {
      const c = await lockCloudLifecycleContext(tx, instanceId);
      if (!await lifecycleActorAuthorized(tx, actor.id, c.account.ownerUserId)) throw new NotFoundException("Cloud instance not found");
      if (input.enabled && lifecycleAuthorizationError(c, "stop")) throw new ForbiddenException("Stopping this instance is not authorized");
      if (input.enabled && (cloudCredentialFingerprint(c.account) !== cloudCredentialFingerprint(owned.account) || c.account.externalAccountId !== owned.account.externalAccountId)) throw new ConflictException("cloud_account_changed");
      const [before] = await tx.select().from(cloudTrafficStopPolicies).where(eq(cloudTrafficStopPolicies.instanceId, instanceId)).for("update");
      if ((before?.revision ?? 0) !== input.revision) throw new ConflictException("Traffic policy revision has changed");
      if (input.enabled && before?.enabled && before.resourceIdentity && before.resourceIdentity !== resourceIdentity) throw new ConflictException("remote_identity_changed");
      const values = { ...input, ...(resourceIdentity === undefined ? {} : { resourceIdentity }), revision: input.revision + 1, actorUserId: actor.id, nextCheckAt: new Date(), leaseHolder: null, leaseExpiresAt: null, lastError: null, triggeredAt: null, updatedAt: new Date() };
      const [after] = await tx.insert(cloudTrafficStopPolicies).values({ instanceId, ...values }).onConflictDoUpdate({ target: cloudTrafficStopPolicies.instanceId, set: values }).returning();
      await tx.update(cloudLifecycleOperations).set({ status: "cancelled", errorCode: "policy_changed", completedAt: new Date(), updatedAt: new Date() }).where(and(eq(cloudLifecycleOperations.instanceId, instanceId), eq(cloudLifecycleOperations.source, "traffic"), eq(cloudLifecycleOperations.status, "queued")));
      await tx.insert(auditLogs).values({ ownerUserId: c.account.ownerUserId, actorUserId: actor.id, source: "user", action: "cloud_instance.traffic_policy", resourceType: "cloud_instance", resourceId: instanceId, beforeSnapshot: publicTrafficPolicy(instanceId, before), afterSnapshot: publicTrafficPolicy(instanceId, after!) });
      return publicTrafficPolicy(instanceId, after!);
    });
  }
  async action(actor: AuthUser, instanceId: string, body: CloudLifecycleActionInput, key: string) {
    const input = cloudLifecycleActionSchema.parse(body);
    key = cloudRequestKey(key);
    const { account, instance } = await this.owned(actor, instanceId);
    const requestHash = createHash("sha256").update(JSON.stringify([instanceId, input.action, input.confirmation ?? null])).digest("hex");
    const [existing] = await this.database.db.select().from(cloudLifecycleOperations).where(and(eq(cloudLifecycleOperations.actorUserId, actor.id), eq(cloudLifecycleOperations.idempotencyKey, key)));
    if (existing) { if (existing.requestHash !== requestHash) throw new ConflictException("Idempotency-Key has already been used"); return publicLifecycleOperation(existing); }
    if (input.action === "delete" && input.confirmation !== instance.externalId) throw new ConflictException("Enter the exact external instance ID to delete");
    // Permission admission precedes any remote I/O; repeat under the dispatch lock below.
    await this.database.db.transaction(async tx => {
      const c = await lockCloudLifecycleContext(tx, instanceId);
      if (!await lifecycleActorAuthorized(tx, actor.id, c.account.ownerUserId) || lifecycleAuthorizationError(c, input.action)) throw new ForbiddenException("Instance action is not authorized");
      if (input.action === "delete") { const protection = await lifecycleDeleteProtection(tx, c); if (protection.reason) throw new ConflictException(protection.reason); }
    });
    const credentials = decryptJson<CloudCredentials>({ ciphertext: account.credentialCiphertext, iv: account.credentialIv, tag: account.credentialTag, keyVersion: account.credentialKeyVersion }, this.encryptionKey);
    const adapter = createCloudAdapter({ accountId: account.id, provider: account.provider, service: instance.service, credentials });
    if ((await adapter.verifyIdentity()).externalAccountId !== account.externalAccountId) throw new ConflictException("remote_identity_changed");
    if (!adapter.inspectLifecycle) throw new ConflictException("lifecycle_unsupported");
    const ref = { accountId: account.id, service: instance.service, region: instance.region, instanceId: instance.externalId };
    const snapshot = await adapter.inspectLifecycle(ref);
    if (!snapshot.identity || snapshot.state === "deleted") throw new ConflictException("resource_not_found");
    const policiesBefore = input.action === "start" ? await this.database.db.transaction(tx => lifecycleTrafficPolicies(tx, { account, instance })) : [];
    const traffic = policiesBefore.length && adapter.monthlyTraffic ? await adapter.monthlyTraffic(ref, new Date()) : null;
    return this.database.db.transaction(async tx => {
      // Actor/key lock handles concurrent retries targeting different instances as well.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${actor.id}:${key}`}, 854719))`);
      const c = await lockCloudLifecycleContext(tx, instanceId);
      const [duplicate] = await tx.select().from(cloudLifecycleOperations).where(and(eq(cloudLifecycleOperations.actorUserId, actor.id), eq(cloudLifecycleOperations.idempotencyKey, key)));
      if (duplicate) { if (duplicate.requestHash !== requestHash) throw new ConflictException("Idempotency-Key has already been used"); return publicLifecycleOperation(duplicate); }
      if (!await lifecycleActorAuthorized(tx, actor.id, c.account.ownerUserId) || lifecycleAuthorizationError(c, input.action)) throw new ForbiddenException("Instance action is not authorized");
      if (cloudCredentialFingerprint(c.account) !== cloudCredentialFingerprint(account) || c.account.externalAccountId !== account.externalAccountId) throw new ConflictException("cloud_account_changed");
      const [pending] = await tx.select().from(cloudLifecycleOperations).where(and(eq(cloudLifecycleOperations.physicalKey, c.physicalKey), inArray(cloudLifecycleOperations.status, [...lifecycleActiveStatuses]))).limit(1);
      if (pending) throw new ConflictException("lifecycle_pending");
      if (input.action === "start") {
        for (const policy of await lifecycleTrafficPolicies(tx, c)) {
          if (!policiesBefore.some(p => p.instanceId === policy.instanceId && p.revision === policy.revision)) throw new ConflictException("policy_changed");
          const usage = traffic ? trafficStopUsage(traffic, policy.direction, new Date()) : null;
          if (usage === null) throw new ConflictException("traffic_usage_unavailable");
          if (usage >= policy.thresholdBytes!) throw new ConflictException("traffic_limit_exceeded_disable_or_raise_policy");
        }
      }
      const protection = input.action === "delete" ? await lifecycleDeleteProtection(tx, c) : { addresses: [], reason: null };
      if (protection.reason) throw new ConflictException(protection.reason);
      const [operation] = await tx.insert(cloudLifecycleOperations).values({ instanceId, physicalKey: c.physicalKey, ownerUserId: c.account.ownerUserId, actorUserId: actor.id, action: input.action, source: "user", idempotencyKey: key, requestHash, externalAccountId: c.account.externalAccountId!, credentialFingerprint: cloudCredentialFingerprint(c.account), snapshot, protectedAddresses: protection.addresses }).returning();
      await tx.insert(auditLogs).values({ ownerUserId: c.account.ownerUserId, actorUserId: actor.id, source: "user", action: `cloud_instance.${input.action}.queued`, resourceType: "cloud_instance", resourceId: instanceId, afterSnapshot: publicLifecycleOperation(operation!) });
      return publicLifecycleOperation(operation!);
    });
  }
}
