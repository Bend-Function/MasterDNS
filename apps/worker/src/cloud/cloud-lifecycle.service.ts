import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq, inArray, lte, or, isNull, sql } from "drizzle-orm";
import { CloudError } from "@masterdns/cloud-providers";
import type { CloudLifecycleSnapshot, MonthlyTraffic } from "@masterdns/contracts";
import { auditLogs, lifecycleTrafficPolicies, publicLifecycleOperation, cloudAccounts, cloudCredentialFingerprint, cloudInstances, cloudInstanceControls, cloudLifecycleOperations, cloudTrafficStopPolicies, lifecycleActiveStatuses, lifecycleActorAuthorized, lifecycleAuthorizationError, lifecycleDeleteProtection, lifecycleReached, lockCloudLifecycleContext, recordCloudRotationThrottle, reserveCloudRotationWrite, rotationLeases, trafficStopUsage, type CloudLifecycleContext, type LifecycleOperationRow, type RotationTransaction } from "@masterdns/db";
import { DatabaseService } from "../database.service.js";
import { CloudRuntimeService } from "./cloud-runtime.service.js";
const delay = (ms: number) => new Date(Date.now() + ms);
const safeError = (error: unknown) => error instanceof CloudError ? error.code : "cloud_query_failed";
@Injectable()
export class CloudLifecycleService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | undefined;
  private stopping = false;
  private readonly logger = new Logger(CloudLifecycleService.name);
  constructor(private readonly database: DatabaseService, private readonly runtime: CloudRuntimeService) {}
  onModuleInit() { this.timer = setInterval(() => this.schedule(), 5000); this.timer.unref(); this.schedule(); }
  async onModuleDestroy() { this.stopping = true; if (this.timer) clearInterval(this.timer); await this.running; }
  private schedule() { if (!this.running && !this.stopping) this.running = this.tick().catch(() => this.logger.error("Cloud lifecycle scheduling failed")).finally(() => { this.running = undefined; }); }
  async tick() {
    // Reserve one lane for each kind: recurring observations cannot starve due policies.
    // Two independent lanes bound remote I/O per process; durable leases cover replicas.
    await Promise.all([this.operationLane(), this.policyLane()]);
  }
  private async operationLane() {
    for (let n = 0; n < 10 && !this.stopping; n++) {
      const operation = await this.claimOperation();
      if (!operation) break;
      await this.processOperation(operation);
    }
  }
  private async policyLane() {
    for (let n = 0; n < 10 && !this.stopping; n++) {
      const policy = await this.claimPolicy();
      if (!policy) break;
      await this.checkPolicy(policy);
    }
  }
  async claimOperation() {
    return this.database.db.transaction(async tx => {
      const [job] = await tx.select().from(cloudLifecycleOperations).where(and(inArray(cloudLifecycleOperations.status, [...lifecycleActiveStatuses]), sql`${cloudLifecycleOperations.nextRunAt} <= clock_timestamp()`, or(isNull(cloudLifecycleOperations.leaseExpiresAt), sql`${cloudLifecycleOperations.leaseExpiresAt} <= clock_timestamp()`))).orderBy(cloudLifecycleOperations.nextRunAt).limit(1).for("update", { skipLocked: true });
      if (!job) return null;
      const [claimed] = await tx.update(cloudLifecycleOperations).set({ leaseHolder: randomUUID(), leaseExpiresAt: delay(120000) }).where(eq(cloudLifecycleOperations.id, job.id)).returning();
      return claimed!;
    });
  }
  async claimPolicy() {
    return this.database.db.transaction(async tx => {
      const [policy] = await tx.select().from(cloudTrafficStopPolicies).where(and(eq(cloudTrafficStopPolicies.enabled, true), sql`${cloudTrafficStopPolicies.nextCheckAt} <= clock_timestamp()`, or(isNull(cloudTrafficStopPolicies.leaseExpiresAt), sql`${cloudTrafficStopPolicies.leaseExpiresAt} <= clock_timestamp()`))).orderBy(cloudTrafficStopPolicies.nextCheckAt).limit(1).for("update", { skipLocked: true });
      if (!policy) return null;
      const [claimed] = await tx.update(cloudTrafficStopPolicies).set({ leaseHolder: randomUUID(), leaseExpiresAt: delay(120000) }).where(eq(cloudTrafficStopPolicies.instanceId, policy.instanceId)).returning();
      return claimed!;
    });
  }
  async checkPolicy(policy: typeof cloudTrafficStopPolicies.$inferSelect) {
    const month = new Date().toISOString().slice(0, 7);
    let snapshot: CloudLifecycleSnapshot | undefined;
    let traffic: MonthlyTraffic | undefined;
    let error: string | null = null;
    let expected: CloudLifecycleContext | undefined;
    try {
      expected = await this.database.db.transaction(async tx => {
        const c = await lockCloudLifecycleContext(tx, policy.instanceId);
        if (lifecycleAuthorizationError(c, "stop") || !await lifecycleActorAuthorized(tx, policy.actorUserId, c.account.ownerUserId)) throw new Error("authorization_revoked");
        return c;
      });
      const adapter = await this.runtime.adapter(expected.account.id, expected.instance.service);
      if (!adapter.monthlyTraffic || !adapter.inspectLifecycle) throw new Error("traffic_unavailable");
      const ref = { accountId: expected.account.id, service: expected.instance.service, region: expected.instance.region, instanceId: expected.instance.externalId };
      snapshot = await adapter.inspectLifecycle(ref);
      if (!policy.resourceIdentity || snapshot.identity !== policy.resourceIdentity) throw new CloudError("remote_identity_changed", false);
      traffic = await adapter.monthlyTraffic(ref, new Date());
    } catch (e) { error = safeError(e); }
    await this.database.db.transaction(async tx => {
      const c = await lockCloudLifecycleContext(tx, policy.instanceId);
      const [current] = await tx.select().from(cloudTrafficStopPolicies).where(eq(cloudTrafficStopPolicies.instanceId, policy.instanceId)).for("update");
      if (!current?.enabled || current.revision !== policy.revision || current.leaseHolder !== policy.leaseHolder) return;
      const now = new Date();
      // A local start/stop may complete while metrics are queried. Its dispatch or
      // completion advances this shared fence, invalidating the older power snapshot.
      if (expected && c.lease.revision !== expected.lease.revision) {
        await tx.update(cloudTrafficStopPolicies).set({ nextCheckAt: now, leaseHolder: null, leaseExpiresAt: null, lastError: "lifecycle_changed", updatedAt: now }).where(eq(cloudTrafficStopPolicies.instanceId, policy.instanceId));
        return;
      }
      const currentMonth = now.toISOString().slice(0, 7);
      const usage = traffic && currentMonth === month ? trafficStopUsage(traffic, current.direction, now) : null;
      if (lifecycleAuthorizationError(c, "stop") || !await lifecycleActorAuthorized(tx, current.actorUserId, c.account.ownerUserId)) error = "authorization_revoked";
      if (expected && (c.physicalKey !== expected.physicalKey || cloudCredentialFingerprint(c.account) !== cloudCredentialFingerprint(expected.account))) error = "cloud_account_changed";
      const values = { month: currentMonth, lastUsageBytes: usage, lastCheckedAt: now, lastError: error ?? (usage === null ? "traffic_usage_unavailable" : null), nextCheckAt: delay(current.checkIntervalSeconds * 1000), leaseHolder: null, leaseExpiresAt: null, updatedAt: now, ...(current.month !== currentMonth ? { triggeredAt: null } : {}) };
      await tx.update(cloudTrafficStopPolicies).set(values).where(eq(cloudTrafficStopPolicies.instanceId, policy.instanceId));
      if (error || usage === null || usage < current.thresholdBytes! || !snapshot?.identity || currentMonth !== month) return;
      const [pending] = await tx.select().from(cloudLifecycleOperations).where(and(eq(cloudLifecycleOperations.physicalKey, c.physicalKey), inArray(cloudLifecycleOperations.status, [...lifecycleActiveStatuses]))).limit(1);
      if (pending) {
        if (pending.action === "start") await tx.update(cloudTrafficStopPolicies).set({ nextCheckAt: delay(5000) }).where(eq(cloudTrafficStopPolicies.instanceId, policy.instanceId));
        return;
      }
      if (snapshot.state === "stopped") {
        await tx.insert(cloudInstanceControls).values({ physicalKey: c.physicalKey, powerHold: "traffic_limit" }).onConflictDoUpdate({ target: cloudInstanceControls.physicalKey, set: { powerHold: "traffic_limit", updatedAt: now } });
        return;
      }
      if (snapshot.state !== "running" && snapshot.state !== "stopped_allocated") return;
      await tx.insert(cloudLifecycleOperations).values({ instanceId: c.instance.id, physicalKey: c.physicalKey, ownerUserId: c.account.ownerUserId, actorUserId: current.actorUserId, action: "stop", source: "traffic", externalAccountId: c.account.externalAccountId!, credentialFingerprint: cloudCredentialFingerprint(c.account), snapshot, policyRevision: current.revision, policyMonth: month });
      await tx.insert(auditLogs).values({ ownerUserId: c.account.ownerUserId, actorUserId: current.actorUserId, source: "sync", action: "cloud_instance.traffic_limit.queued", resourceType: "cloud_instance", resourceId: c.instance.id, afterSnapshot: { policyRevision: current.revision, month, usageBytes: usage } });
      await tx.update(cloudTrafficStopPolicies).set({ triggeredAt: now }).where(eq(cloudTrafficStopPolicies.instanceId, policy.instanceId));
    });
  }
  private async finish(tx: RotationTransaction, job: LifecycleOperationRow, c: CloudLifecycleContext, status: "succeeded" | "failed" | "cancelled", errorCode: string | null = null) {
    const [updated] = await tx.update(cloudLifecycleOperations).set({ status, errorCode, completedAt: new Date(), updatedAt: new Date(), leaseHolder: null, leaseExpiresAt: null }).where(and(eq(cloudLifecycleOperations.id, job.id), eq(cloudLifecycleOperations.leaseHolder, job.leaseHolder!))).returning();
    if (!updated) return;
    await tx.insert(auditLogs).values({ ownerUserId: job.ownerUserId, actorUserId: job.actorUserId, source: job.source === "user" ? "user" : "sync", action: `cloud_instance.${job.action}.${status}`, resourceType: "cloud_instance", resourceId: job.instanceId, afterSnapshot: publicLifecycleOperation(updated) });
    if (status === "succeeded") {
      // Also fence no-write successes (e.g. a queued start found already running).
      await tx.update(rotationLeases).set({ revision: sql`${rotationLeases.revision}+1`, updatedAt: new Date() }).where(eq(rotationLeases.physicalKey, job.physicalKey));
      const powerHold = job.action === "start" ? null : job.action === "delete" ? "deleted" : job.source === "traffic" ? "traffic_limit" : "manual_stop";
      await tx.insert(cloudInstanceControls).values({ physicalKey: job.physicalKey, powerHold }).onConflictDoUpdate({ target: cloudInstanceControls.physicalKey, set: { powerHold, updatedAt: new Date() } });
      await tx.update(cloudInstances).set({ state: job.action === "start" ? "running" : job.action === "stop" ? "stopped" : "deleted", ...(job.action === "delete" ? { metadata: { ...c.instance.metadata, present: false } } : {}), updatedAt: new Date() }).where(eq(cloudInstances.id, job.instanceId));
      if (job.action === "delete") await tx.update(cloudTrafficStopPolicies).set({ enabled: false, updatedAt: new Date() }).where(eq(cloudTrafficStopPolicies.instanceId, job.instanceId));
    }
    await tx.update(rotationLeases).set({ holder: null, expiresAt: new Date(), updatedAt: new Date() }).where(and(eq(rotationLeases.physicalKey, job.physicalKey), eq(rotationLeases.holder, job.id)));
  }
  async processOperation(job: LifecycleOperationRow) {
    let c: CloudLifecycleContext;
    try { c = await this.database.db.transaction(tx => lockCloudLifecycleContext(tx, job.instanceId)); }
    catch { return; }
    const observing = job.status !== "queued";
    try {
      const adapter = await this.runtime.adapter(c.account.id, c.instance.service, { observation: observing });
      if (!adapter.inspectLifecycle || !adapter.mutateLifecycle) throw new Error("lifecycle_unsupported");
      const identity = await adapter.verifyIdentity();
      if (identity.externalAccountId !== job.externalAccountId) throw new CloudError("remote_identity_changed", false);
      const ref = { accountId: c.account.id, service: c.instance.service, region: c.instance.region, instanceId: c.instance.externalId };
      let snapshot: CloudLifecycleSnapshot;
      try { snapshot = await adapter.inspectLifecycle(ref); }
      catch (e) { if (observing && job.action === "delete" && job.snapshot && e instanceof CloudError && e.code === "resource_not_found") snapshot = { ...job.snapshot, state: "deleted" }; else throw e; }
      if (snapshot.state !== "deleted" && job.snapshot && snapshot.identity !== job.snapshot.identity) throw new CloudError("remote_identity_changed", false);
      if (!observing && (!snapshot.identity || snapshot.state === "deleted")) throw new CloudError("resource_not_found", false);
      // Fresh traffic data is mandatory at dispatch, including queued manual starts.
      const [policy] = await this.database.db.select().from(cloudTrafficStopPolicies).where(eq(cloudTrafficStopPolicies.instanceId, job.instanceId));
      const startPolicies = !observing && job.action === "start" ? await this.database.db.transaction(tx => lifecycleTrafficPolicies(tx, c)) : [];
      let traffic: MonthlyTraffic | undefined;
      if (!observing && (job.source === "traffic" || startPolicies.length)) {
        if (!adapter.monthlyTraffic) throw new Error("traffic_usage_unavailable");
        traffic = await adapter.monthlyTraffic(ref, new Date());
      }
      const dispatch = await this.database.db.transaction(async tx => {
        const current = await lockCloudLifecycleContext(tx, job.instanceId);
        const [live] = await tx.select().from(cloudLifecycleOperations).where(eq(cloudLifecycleOperations.id, job.id)).for("update");
        if (!live || live.leaseHolder !== job.leaseHolder || !lifecycleActiveStatuses.includes(live.status as typeof lifecycleActiveStatuses[number])) return false;
        if (observing) {
          if (lifecycleReached(job.action, snapshot.state)) await this.finish(tx, job, current, "succeeded");
          else await this.defer(tx, job, live.dispatchedAt && Date.now() - live.dispatchedAt.getTime() > 900000 ? "unknown" : live.status, "awaiting_observation", delay(15000));
          return false;
        }
        const authError = lifecycleAuthorizationError(current, job.action);
        if (authError || current.account.ownerUserId !== job.ownerUserId || !await lifecycleActorAuthorized(tx, job.actorUserId, current.account.ownerUserId)) { await this.finish(tx, job, current, "cancelled", authError ?? "authorization_revoked"); return false; }
        if (current.physicalKey !== job.physicalKey || current.account.externalAccountId !== job.externalAccountId || cloudCredentialFingerprint(current.account) !== job.credentialFingerprint) { await this.finish(tx, job, current, "cancelled", "cloud_account_changed"); return false; }
        const [currentPolicy] = await tx.select().from(cloudTrafficStopPolicies).where(eq(cloudTrafficStopPolicies.instanceId, job.instanceId)).for("update");
        if (job.source === "traffic") {
          const usage = traffic && currentPolicy ? trafficStopUsage(traffic, currentPolicy.direction, new Date()) : null;
          if (!currentPolicy?.enabled || currentPolicy.revision !== job.policyRevision || currentPolicy.revision !== policy?.revision || job.policyMonth !== new Date().toISOString().slice(0, 7) || usage === null || usage < currentPolicy.thresholdBytes!) { await this.finish(tx, job, current, "cancelled", "policy_changed"); return false; }
        }
        if (job.action === "start") {
          for (const startPolicy of await lifecycleTrafficPolicies(tx, current)) {
            const usage = traffic ? trafficStopUsage(traffic, startPolicy.direction, new Date()) : null;
            if (!startPolicies.some(p => p.instanceId === startPolicy.instanceId && p.revision === startPolicy.revision) || usage === null || usage >= startPolicy.thresholdBytes!) { await this.finish(tx, job, current, "cancelled", "traffic_limit_exceeded_disable_or_raise_policy"); return false; }
          }
        }
        if (current.lease.unresolvedStepId || (current.lease.holder && current.lease.holder !== job.id && current.lease.expiresAt > new Date())) { await this.defer(tx, job, "queued", "rotation_in_progress", delay(5000)); return false; }
        if (job.action === "delete") { const protection = await lifecycleDeleteProtection(tx, current); if (protection.reason) { await this.finish(tx, job, current, "cancelled", protection.reason); return false; } await tx.update(cloudLifecycleOperations).set({ protectedAddresses: protection.addresses }).where(eq(cloudLifecycleOperations.id, job.id)); }
        if (lifecycleReached(job.action, snapshot.state)) { await this.finish(tx, job, current, "succeeded"); return false; }
        const admission = await reserveCloudRotationWrite(tx, { accountId: current.account.id, service: current.instance.service, region: current.instance.region, stepId: `lifecycle:${job.id}`, action: `${current.instance.service}.instance.${job.action}` });
        if (!admission.allowed) { await this.defer(tx, job, "queued", "rate_limited", admission.retryAt); return false; }
        await tx.update(rotationLeases).set({ holder: job.id, expiresAt: delay(120000), revision: sql`${rotationLeases.revision}+1`, updatedAt: new Date() }).where(eq(rotationLeases.physicalKey, job.physicalKey));
        await tx.update(cloudLifecycleOperations).set({ status: "in_flight", snapshot, dispatchedAt: new Date(), updatedAt: new Date() }).where(eq(cloudLifecycleOperations.id, job.id));
        return true;
      });
      if (!dispatch) return;
      // The durable dispatch is the authorization boundary. Never repeat an uncertain write.
      try {
        await adapter.mutateLifecycle(job.action, snapshot);
        await this.database.db.transaction(tx => this.defer(tx, job, "in_flight", null, delay(5000)));
      } catch (e) {
        await this.database.db.transaction(async tx => {
          const current = await lockCloudLifecycleContext(tx, job.instanceId);
          if (e instanceof CloudError && e.code === "rate_limited") {
            const retryAt = await recordCloudRotationThrottle(tx, { accountId: current.account.id, service: current.instance.service, region: current.instance.region, stepId: `lifecycle:${job.id}`, action: `${current.instance.service}.instance.${job.action}`, ...(e.retryAfterMs === undefined ? {} : { retryAfterMs: e.retryAfterMs }) });
            await this.defer(tx, job, "queued", "rate_limited", retryAt);
            await tx.update(rotationLeases).set({ holder: null, expiresAt: new Date() }).where(and(eq(rotationLeases.physicalKey, job.physicalKey), eq(rotationLeases.holder, job.id)));
          } else if (e instanceof CloudError && ["permission_denied", "invalid_credentials", "credentials_expired", "quota_exceeded"].includes(e.code)) await this.finish(tx, job, current, "failed", e.code);
          else await this.defer(tx, job, "unknown", safeError(e), delay(15000));
        });
      }
    } catch (e) {
      await this.database.db.transaction(async tx => {
        const current = await lockCloudLifecycleContext(tx, job.instanceId);
        if (observing) await this.defer(tx, job, "unknown", safeError(e), delay(30000));
        else await this.finish(tx, job, current, "failed", safeError(e));
      });
    }
  }
  private async defer(tx: RotationTransaction, job: LifecycleOperationRow, status: LifecycleOperationRow["status"], errorCode: string | null, nextRunAt: Date) {
    await tx.update(cloudLifecycleOperations).set({ status, errorCode, nextRunAt, updatedAt: new Date(), leaseHolder: null, leaseExpiresAt: null }).where(and(eq(cloudLifecycleOperations.id, job.id), eq(cloudLifecycleOperations.leaseHolder, job.leaseHolder!)));
  }
}
