import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { healthCheckConfigSchema, type HealthCheckConfig, type HealthCheckJob, type PoolReconcileJob } from "@masterdns/contracts";
import {
  auditLogs,
  bindingAssignments,
  bindingEndpointHealth,
  ddnsAgents,
  dnsRecords,
  domainBindings,
  endpointAddresses,
  endpointPools,
  endpoints,
  failoverEvents,
  healthCheckConfigs,
  healthCheckResults,
  operationSteps,
  operations,
  policyVersions,
  providerAccounts,
  reconcileIntents,
  zones,
} from "@masterdns/db";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuthUser } from "../../auth/auth.types.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { QueueService } from "../../infrastructure/queue.module.js";
import type {
  CreateBindingInput,
  CreateEndpointInput,
  CreatePoolInput,
  UpdateBindingInput,
  UpdateEndpointInput,
  UpdatePoolInput,
} from "./pools.schemas.js";

const policySnapshotSchema = z.object({
  pool: z.object({
    name: z.string().min(1).max(120),
    description: z.string().nullable().optional(),
    strategy: z.enum(["primary_backup", "healthy_set", "assignment_pool"]),
    selectionMode: z.enum(["random", "ordered", "round_robin", "least_assigned"]),
    recoveryMode: z.enum(["automatic", "keep_current", "manual", "delayed"]),
    recoveryDelaySeconds: z.number().int().nonnegative(),
    failureThreshold: z.number().int().positive(),
    successThreshold: z.number().int().positive(),
    checkIntervalSeconds: z.number().int().min(5),
    checkTimeoutMs: z.number().int().positive(),
    switchCooldownSeconds: z.number().int().nonnegative(),
    allDownReminderSeconds: z.number().int().min(60).default(1800),
    enabled: z.boolean(),
  }),
  endpoints: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(120),
    addressMode: z.enum(["static", "ddns"]),
    priority: z.number().int().nonnegative(),
    lifecycle: z.enum(["enabled", "disabled", "maintenance", "draining"]),
  })),
  addresses: z.array(z.object({
    endpointId: z.string().uuid(),
    family: z.enum(["4", "6"]),
    address: z.string().min(1),
    state: z.enum(["candidate", "current", "previous"]),
    source: z.enum(["static", "ddns"]),
  })).default([]),
  bindings: z.array(z.object({
    id: z.string().uuid(),
    zoneId: z.string().uuid(),
    fqdn: z.string().min(1).max(255),
    recordType: z.enum(["A", "AAAA"]),
    ttl: z.number().int().positive(),
    providerMetadata: z.record(z.string(), z.unknown()).default({}),
    originalEndpointId: z.string().uuid().nullable().optional(),
  })),
  healthChecks: z.array(z.object({
    id: z.string().uuid(),
    poolId: z.string().uuid().nullable().optional(),
    endpointId: z.string().uuid().nullable().optional(),
    domainBindingId: z.string().uuid().nullable().optional(),
    checkerType: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
    enabled: z.boolean(),
    revision: z.number().int().positive(),
  }).refine((check) => [check.poolId, check.endpointId, check.domainBindingId].filter(Boolean).length === 1, "健康检查作用域无效")),
});

type PolicySnapshot = z.infer<typeof policySnapshotSchema>;
type DatabaseTransaction = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];

export function validateRestorablePolicySnapshot(snapshot: PolicySnapshot, poolId: string) {
  const endpointIds = new Set(snapshot.endpoints.map((endpoint) => endpoint.id));
  const bindingIds = new Set(snapshot.bindings.map((binding) => binding.id));
  for (const endpoint of snapshot.endpoints) {
    if (endpoint.addressMode !== "static") continue;
    const currentStaticAddresses = snapshot.addresses.filter((address) => (
      address.endpointId === endpoint.id
      && address.state === "current"
      && address.source === "static"
    ));
    if (currentStaticAddresses.length === 0) throw new ConflictException(`历史节点 ${endpoint.name} 没有可恢复的静态地址`);
    if (new Set(currentStaticAddresses.map((address) => address.family)).size !== currentStaticAddresses.length) {
      throw new ConflictException(`历史节点 ${endpoint.name} 包含重复的静态地址族`);
    }
    for (const address of currentStaticAddresses) {
      if (isIP(address.address) !== Number(address.family)) throw new ConflictException(`历史节点 ${endpoint.name} 包含无效的 IPv${address.family} 地址`);
    }
  }
  for (const check of snapshot.healthChecks) {
    const config = healthCheckConfigSchema.safeParse(check.config);
    const validScope = check.poolId === poolId
      || Boolean(check.endpointId && endpointIds.has(check.endpointId))
      || Boolean(check.domainBindingId && bindingIds.has(check.domainBindingId));
    if (!config.success || config.data.type !== check.checkerType || !validScope) throw new ConflictException("历史版本包含无效的健康检查配置");
  }
  return { endpointIds, bindingIds };
}

@Injectable()
export class PoolsService {
  constructor(private readonly database: DatabaseService, private readonly queues: QueueService) {}

  async list(actor: AuthUser) {
    const pools = await this.database.db.select().from(endpointPools)
      .where(actor.role === "admin" ? undefined : eq(endpointPools.ownerUserId, actor.id))
      .orderBy(asc(endpointPools.name));
    const poolIds = pools.map((pool) => pool.id);
    if (poolIds.length === 0) return [];
    const [endpointRows, bindingRows] = await Promise.all([
      this.database.db.select({ poolId: endpoints.poolId, state: endpoints.healthState }).from(endpoints).where(inArray(endpoints.poolId, poolIds)),
      this.database.db.select({ poolId: domainBindings.poolId }).from(domainBindings).where(inArray(domainBindings.poolId, poolIds)),
    ]);
    return pools.map((pool) => ({
      ...pool,
      endpointCount: endpointRows.filter((row) => row.poolId === pool.id).length,
      healthyEndpointCount: endpointRows.filter((row) => row.poolId === pool.id && row.state === "healthy").length,
      bindingCount: bindingRows.filter((row) => row.poolId === pool.id).length,
    }));
  }

  async create(actor: AuthUser, input: CreatePoolInput) {
    const [pool] = await this.database.db.insert(endpointPools).values({ ownerUserId: actor.id, ...input }).returning();
    if (!pool) throw new Error("Pool insert returned no row");
    await this.database.db.transaction(async (tx) => {
      await tx.insert(policyVersions).values({ poolId: pool.id, version: 1, snapshot: { pool, endpoints: [], bindings: [], healthChecks: [] }, reason: "pool.create", actorUserId: actor.id });
      await tx.insert(auditLogs).values({ ownerUserId: pool.ownerUserId, actorUserId: actor.id, source: "user", action: "pool.create", resourceType: "endpoint_pool", resourceId: pool.id, afterSnapshot: pool });
    });
    return pool;
  }

  async get(actor: AuthUser, poolId: string) {
    const pool = await this.findOwnedPool(actor, poolId);
    const [endpointRows, addresses, bindings, assignments, checks, results, events, versions] = await Promise.all([
      this.database.db.select().from(endpoints).where(eq(endpoints.poolId, poolId)).orderBy(asc(endpoints.priority), asc(endpoints.name)),
      this.database.db.select({ address: endpointAddresses, poolId: endpoints.poolId }).from(endpointAddresses)
        .innerJoin(endpoints, eq(endpointAddresses.endpointId, endpoints.id)).where(eq(endpoints.poolId, poolId)),
      this.database.db.select({ binding: domainBindings, zoneName: zones.nameAscii, provider: providerAccounts.provider })
        .from(domainBindings).innerJoin(zones, eq(domainBindings.zoneId, zones.id))
        .innerJoin(providerAccounts, eq(zones.providerAccountId, providerAccounts.id))
        .where(eq(domainBindings.poolId, poolId)).orderBy(asc(domainBindings.fqdn)),
      this.database.db.select({ assignment: bindingAssignments, poolId: domainBindings.poolId })
        .from(bindingAssignments).innerJoin(domainBindings, eq(bindingAssignments.domainBindingId, domainBindings.id))
        .where(eq(domainBindings.poolId, poolId)),
      this.database.db.select().from(healthCheckConfigs).where(or(
        eq(healthCheckConfigs.poolId, poolId),
        inArray(healthCheckConfigs.endpointId, this.database.db.select({ id: endpoints.id }).from(endpoints).where(eq(endpoints.poolId, poolId))),
        inArray(healthCheckConfigs.domainBindingId, this.database.db.select({ id: domainBindings.id }).from(domainBindings).where(eq(domainBindings.poolId, poolId))),
      )),
      this.database.db.select({ result: healthCheckResults, endpointName: endpoints.name })
        .from(healthCheckResults).innerJoin(endpoints, eq(healthCheckResults.endpointId, endpoints.id))
        .where(eq(endpoints.poolId, poolId)).orderBy(desc(healthCheckResults.checkedAt)).limit(100),
      this.database.db.select().from(failoverEvents).where(eq(failoverEvents.poolId, poolId)).orderBy(desc(failoverEvents.createdAt)).limit(100),
      this.database.db.select().from(policyVersions).where(eq(policyVersions.poolId, poolId)).orderBy(desc(policyVersions.version)).limit(50),
    ]);
    return {
      pool,
      endpoints: endpointRows.map((endpoint) => ({ ...endpoint, addresses: addresses.filter((row) => row.address.endpointId === endpoint.id).map((row) => row.address) })),
      bindings: bindings.map((row) => ({ ...row.binding, zoneName: row.zoneName, provider: row.provider, assignments: assignments.filter((item) => item.assignment.domainBindingId === row.binding.id).map((item) => item.assignment) })),
      healthChecks: checks,
      healthResults: results,
      events,
      policyVersions: versions,
    };
  }

  async update(actor: AuthUser, poolId: string, input: UpdatePoolInput) {
    const current = await this.findOwnedPool(actor, poolId);
    const effectiveStrategy = input.strategy ?? current.strategy;
    if (effectiveStrategy !== "healthy_set") {
      const missingOriginal = await this.database.db.select({ id: domainBindings.id }).from(domainBindings).where(and(
        eq(domainBindings.poolId, poolId),
        isNull(domainBindings.originalEndpointId),
      )).limit(1);
      if (missingOriginal.length > 0) throw new ConflictException("切换到该策略前，必须为每个域名绑定指定原始节点");
    }
    const [updated] = await this.database.db.update(endpointPools).set({ ...input, updatedAt: new Date() }).where(eq(endpointPools.id, poolId)).returning();
    if (!updated) throw new Error("Pool update returned no row");
    await this.recordPolicyChange(actor, poolId, "pool.update", current, updated);
    await this.enqueueReconcile(poolId, "configuration");
    return updated;
  }

  async restorePolicyVersion(actor: AuthUser, poolId: string, version: number, input: { force: boolean }) {
    await this.findOwnedPool(actor, poolId);
    const [targetVersion] = await this.database.db.select().from(policyVersions).where(and(
      eq(policyVersions.poolId, poolId),
      eq(policyVersions.version, version),
    )).limit(1);
    if (!targetVersion) throw new NotFoundException("策略版本不存在");
    const parsed = policySnapshotSchema.safeParse(targetVersion.snapshot);
    if (!parsed.success) throw new ConflictException("该历史版本格式不完整，无法安全回滚");
    const snapshot = parsed.data;
    const { bindingIds } = validateRestorablePolicySnapshot(snapshot, poolId);
    const eventId = randomUUID();

    const restored = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${poolId}))`);
      const [lockedPool] = await tx.select().from(endpointPools).where(eq(endpointPools.id, poolId)).limit(1).for("update");
      if (!lockedPool || (actor.role !== "admin" && lockedPool.ownerUserId !== actor.id)) throw new NotFoundException("IP Pool 不存在");

      const [currentEndpoints, currentBindings, currentChecks, currentAddresses] = await Promise.all([
        tx.select().from(endpoints).where(eq(endpoints.poolId, poolId)).for("update"),
        tx.select().from(domainBindings).where(eq(domainBindings.poolId, poolId)).for("update"),
        tx.select().from(healthCheckConfigs).where(or(
          eq(healthCheckConfigs.poolId, poolId),
          inArray(healthCheckConfigs.endpointId, tx.select({ id: endpoints.id }).from(endpoints).where(eq(endpoints.poolId, poolId))),
          inArray(healthCheckConfigs.domainBindingId, tx.select({ id: domainBindings.id }).from(domainBindings).where(eq(domainBindings.poolId, poolId))),
        )).for("update"),
        tx.select({ address: endpointAddresses }).from(endpointAddresses)
          .innerJoin(endpoints, eq(endpointAddresses.endpointId, endpoints.id)).where(eq(endpoints.poolId, poolId)),
      ]);
      if (!sameIdSet(currentEndpoints, snapshot.endpoints) || !sameIdSet(currentBindings, snapshot.bindings)) {
        throw new ConflictException("旧版本与当前版本的节点或域名绑定集合不同；请先通过节点/绑定流程恢复相同结构，再重试策略回滚");
      }

      const restoredAt = new Date();
      const [pool] = await tx.update(endpointPools).set({
        name: snapshot.pool.name,
        description: snapshot.pool.description ?? null,
        strategy: snapshot.pool.strategy,
        selectionMode: snapshot.pool.selectionMode,
        recoveryMode: snapshot.pool.recoveryMode,
        recoveryDelaySeconds: snapshot.pool.recoveryDelaySeconds,
        failureThreshold: snapshot.pool.failureThreshold,
        successThreshold: snapshot.pool.successThreshold,
        checkIntervalSeconds: snapshot.pool.checkIntervalSeconds,
        checkTimeoutMs: snapshot.pool.checkTimeoutMs,
        switchCooldownSeconds: snapshot.pool.switchCooldownSeconds,
        allDownReminderSeconds: snapshot.pool.allDownReminderSeconds,
        state: "unknown",
        roundRobinCursor: null,
        roundRobinCursors: {},
        enabled: snapshot.pool.enabled,
        pausedAt: snapshot.pool.enabled ? null : restoredAt,
        enabledAt: snapshot.pool.enabled ? restoredAt : lockedPool.enabledAt,
        policyRevision: sql`${endpointPools.policyRevision} + 1`,
        decisionRevision: sql`${endpointPools.decisionRevision} + 1`,
        updatedAt: restoredAt,
      }).where(eq(endpointPools.id, poolId)).returning();
      if (!pool) throw new NotFoundException("IP Pool 不存在");

      for (const endpoint of snapshot.endpoints) {
        await restoreEndpointPolicy(tx, poolId, endpoint, snapshot.addresses, restoredAt);
      }
      for (const binding of snapshot.bindings) {
        await tx.update(domainBindings).set({
          zoneId: binding.zoneId,
          fqdn: binding.fqdn,
          recordType: binding.recordType,
          ttl: binding.ttl,
          providerMetadata: binding.providerMetadata,
          originalEndpointId: binding.originalEndpointId ?? null,
          desiredRevision: pool.policyRevision,
          updatedAt: restoredAt,
        }).where(and(eq(domainBindings.id, binding.id), eq(domainBindings.poolId, poolId)));
      }
      if (bindingIds.size > 0) {
        await tx.delete(bindingEndpointHealth).where(inArray(bindingEndpointHealth.domainBindingId, [...bindingIds]));
      }

      const targetCheckIds = new Set(snapshot.healthChecks.map((check) => check.id));
      const removedCheckIds = currentChecks.filter((check) => !targetCheckIds.has(check.id)).map((check) => check.id);
      if (removedCheckIds.length > 0) await tx.delete(healthCheckConfigs).where(inArray(healthCheckConfigs.id, removedCheckIds));
      for (const check of snapshot.healthChecks) {
        await tx.insert(healthCheckConfigs).values({
          id: check.id,
          poolId: check.poolId ?? null,
          endpointId: check.endpointId ?? null,
          domainBindingId: check.domainBindingId ?? null,
          checkerType: check.checkerType,
          config: check.config,
          enabled: check.enabled,
          revision: check.revision,
        }).onConflictDoUpdate({
          target: healthCheckConfigs.id,
          set: {
            poolId: check.poolId ?? null,
            endpointId: check.endpointId ?? null,
            domainBindingId: check.domainBindingId ?? null,
            checkerType: check.checkerType,
            config: check.config,
            enabled: check.enabled,
            revision: check.revision,
            updatedAt: restoredAt,
          },
        });
      }

      const [restoredEndpoints, restoredAddresses, restoredBindings, restoredChecks] = await Promise.all([
        tx.select().from(endpoints).where(eq(endpoints.poolId, poolId)),
        tx.select({ address: endpointAddresses }).from(endpointAddresses).innerJoin(endpoints, eq(endpointAddresses.endpointId, endpoints.id)).where(eq(endpoints.poolId, poolId)),
        tx.select().from(domainBindings).where(eq(domainBindings.poolId, poolId)),
        tx.select().from(healthCheckConfigs).where(or(
          eq(healthCheckConfigs.poolId, poolId),
          inArray(healthCheckConfigs.endpointId, tx.select({ id: endpoints.id }).from(endpoints).where(eq(endpoints.poolId, poolId))),
          inArray(healthCheckConfigs.domainBindingId, tx.select({ id: domainBindings.id }).from(domainBindings).where(eq(domainBindings.poolId, poolId))),
        )),
      ]);
      const restoredSnapshot = { pool, endpoints: restoredEndpoints, addresses: restoredAddresses.map((row) => row.address), bindings: restoredBindings, healthChecks: restoredChecks };
      await tx.insert(policyVersions).values({ poolId, version: pool.policyRevision, snapshot: restoredSnapshot, reason: `policy.rollback:${version}`, actorUserId: actor.id });
      await tx.insert(reconcileIntents).values({
        eventId,
        poolId,
        decisionRevision: pool.decisionRevision,
        policyRevision: pool.policyRevision,
        trigger: "configuration",
        source: "rollback",
        force: input.force,
        availableAt: restoredAt,
      });
      await tx.insert(auditLogs).values({
        ownerUserId: lockedPool.ownerUserId,
        actorUserId: actor.id,
        source: "rollback",
        action: "policy.rollback",
        resourceType: "endpoint_pool",
        resourceId: poolId,
        beforeSnapshot: { pool: lockedPool, endpoints: currentEndpoints, addresses: currentAddresses.map((row) => row.address), bindings: currentBindings, healthChecks: currentChecks },
        afterSnapshot: { restoredFromVersion: version, newVersion: pool.policyRevision },
        eventId,
      });
      return {
        pool,
        reconcile: {
          queued: true,
          eventId,
          decisionRevision: pool.decisionRevision,
          policyRevision: pool.policyRevision,
        },
      };
    }, { isolationLevel: "serializable" });
    return { pool: restored.pool, restoredFromVersion: version, reconcile: restored.reconcile };
  }

  async pause(actor: AuthUser, poolId: string) {
    const current = await this.findOwnedPool(actor, poolId);
    const [updated] = await this.database.db.update(endpointPools).set({ enabled: false, pausedAt: new Date(), updatedAt: new Date() }).where(eq(endpointPools.id, poolId)).returning();
    await this.recordPolicyChange(actor, poolId, "pool.pause", current, updated);
    return updated;
  }

  async resume(actor: AuthUser, poolId: string) {
    const current = await this.findOwnedPool(actor, poolId);
    const [updated] = await this.database.db.update(endpointPools).set({ enabled: true, enabledAt: new Date(), pausedAt: null, updatedAt: new Date() }).where(eq(endpointPools.id, poolId)).returning();
    await this.recordPolicyChange(actor, poolId, "pool.resume", current, updated);
    await this.enqueueReconcile(poolId, "configuration");
    return updated;
  }

  async reconcile(actor: AuthUser, poolId: string, input: { force: boolean }) {
    await this.findOwnedPool(actor, poolId);
    return this.enqueueReconcile(poolId, "rebalance", input.force);
  }

  async remove(actor: AuthUser, poolId: string) {
    const pool = await this.findOwnedPool(actor, poolId);
    const bindings = await this.database.db.select({ id: domainBindings.id }).from(domainBindings).where(eq(domainBindings.poolId, poolId)).limit(1);
    if (bindings.length > 0) throw new ConflictException("请先删除 Pool 中的域名绑定，系统不会直接遗留云端记录");
    await this.database.db.transaction(async (tx) => {
      await tx.insert(auditLogs).values({ ownerUserId: pool.ownerUserId, actorUserId: actor.id, source: "user", action: "pool.delete", resourceType: "endpoint_pool", resourceId: pool.id, beforeSnapshot: pool });
      await tx.delete(endpointPools).where(eq(endpointPools.id, poolId));
    });
    return { deleted: true };
  }

  async createEndpoint(actor: AuthUser, poolId: string, input: CreateEndpointInput) {
    await this.findOwnedPool(actor, poolId);
    const endpoint = await this.database.db.transaction(async (tx) => {
      const [created] = await tx.insert(endpoints).values({
        poolId,
        name: input.name,
        addressMode: input.addressMode,
        priority: input.priority,
        lifecycle: input.lifecycle,
      }).returning();
      if (!created) throw new Error("Endpoint insert returned no row");
      if (input.ipv4) await tx.insert(endpointAddresses).values({ endpointId: created.id, family: "4", address: input.ipv4, state: "current", source: "static", promotedAt: new Date() });
      if (input.ipv6) await tx.insert(endpointAddresses).values({ endpointId: created.id, family: "6", address: input.ipv6, state: "current", source: "static", promotedAt: new Date() });
      if (input.addressMode === "ddns") await tx.insert(ddnsAgents).values({ endpointId: created.id });
      return created;
    });
    await this.recordPolicyChange(actor, poolId, "endpoint.create", undefined, endpoint);
    await this.enqueueReconcile(poolId, "configuration");
    return endpoint;
  }

  async updateEndpoint(actor: AuthUser, poolId: string, endpointId: string, input: UpdateEndpointInput) {
    await this.findOwnedPool(actor, poolId);
    const current = await this.findEndpoint(poolId, endpointId);
    const { ipv4, ipv6, forceApply, addressMode, ...fields } = input;
    const updated = await this.database.db.transaction(async (tx) => {
      const [lockedEndpoint] = await tx.select().from(endpoints).where(and(
        eq(endpoints.id, endpointId),
        eq(endpoints.poolId, poolId),
      )).limit(1).for("update");
      if (!lockedEndpoint) throw new NotFoundException("节点不存在");

      const convertingToStatic = lockedEndpoint.addressMode === "ddns" && addressMode === "static";
      let addressChanged = false;
      if (convertingToStatic) {
        if (!ipv4 && !ipv6) throw new BadRequestException("切换为静态节点时至少提供一个 IP 地址");

        const now = new Date();
        await tx.select({ id: ddnsAgents.id }).from(ddnsAgents)
          .where(eq(ddnsAgents.endpointId, endpointId)).limit(1).for("update");
        await tx.update(endpointAddresses).set({ state: "previous", replacedAt: now }).where(and(
          eq(endpointAddresses.endpointId, endpointId),
          or(eq(endpointAddresses.state, "candidate"), eq(endpointAddresses.state, "current")),
        ));
        if (ipv4) await tx.insert(endpointAddresses).values({
          endpointId,
          family: "4",
          address: ipv4,
          state: "current",
          source: "static",
          promotedAt: now,
        });
        if (ipv6) await tx.insert(endpointAddresses).values({
          endpointId,
          family: "6",
          address: ipv6,
          state: "current",
          source: "static",
          promotedAt: now,
        });
        await disableDdnsAgent(tx, endpointId, now);
        addressChanged = true;
      } else if (ipv4 !== undefined || ipv6 !== undefined) {
        if (lockedEndpoint.addressMode !== "static") throw new ConflictException("DDNS 节点地址只能由 Agent 上报；请显式切换为静态节点");
        if (ipv4 !== undefined) addressChanged = await replaceStaticAddress(tx, endpointId, "4", ipv4) || addressChanged;
        if (ipv6 !== undefined) addressChanged = await replaceStaticAddress(tx, endpointId, "6", ipv6) || addressChanged;
        const remaining = await tx.select({ id: endpointAddresses.id }).from(endpointAddresses)
          .where(and(eq(endpointAddresses.endpointId, endpointId), eq(endpointAddresses.state, "current")));
        if (remaining.length === 0) throw new BadRequestException("静态节点至少需要一个当前 IP 地址");
      }
      const [row] = await tx.update(endpoints).set({
        ...fields,
        ...(addressMode ? { addressMode } : {}),
        ...(addressChanged ? {
          healthState: "unknown" as const,
          consecutiveSuccesses: 0,
          consecutiveFailures: 0,
          lastCheckedAt: null,
          stateChangedAt: new Date(),
        } : {}),
        updatedAt: new Date(),
      }).where(eq(endpoints.id, endpointId)).returning();
      return row;
    });
    if (!updated) throw new Error("Endpoint update returned no row");
    await this.recordPolicyChange(actor, poolId, "endpoint.update", current, updated);
    await this.enqueueReconcile(poolId, "configuration", forceApply);
    return updated;
  }

  async deleteEndpoint(actor: AuthUser, poolId: string, endpointId: string) {
    const pool = await this.findOwnedPool(actor, poolId);
    const endpoint = await this.findEndpoint(poolId, endpointId);
    const [assignment, binding] = await Promise.all([
      this.database.db.select({ id: bindingAssignments.endpointId }).from(bindingAssignments).where(and(
        eq(bindingAssignments.endpointId, endpointId),
        or(eq(bindingAssignments.desired, true), eq(bindingAssignments.applied, true)),
      )).limit(1),
      this.database.db.select({ id: domainBindings.id }).from(domainBindings).where(eq(domainBindings.originalEndpointId, endpointId)).limit(1),
    ]);
    if (assignment.length > 0 || binding.length > 0) throw new ConflictException("节点仍被域名绑定引用，请先调整绑定或重新平衡");
    await this.database.db.transaction(async (tx) => {
      await tx.delete(bindingAssignments).where(eq(bindingAssignments.endpointId, endpointId));
      await tx.delete(endpoints).where(eq(endpoints.id, endpointId));
    });
    await this.recordPolicyChange(actor, poolId, "endpoint.delete", endpoint, undefined, pool.ownerUserId);
    return { deleted: true };
  }

  async checkEndpoint(actor: AuthUser, poolId: string, endpointId: string) {
    await this.findOwnedPool(actor, poolId);
    await this.findEndpoint(poolId, endpointId);
    const configs = await this.database.db.select().from(healthCheckConfigs).where(and(
      eq(healthCheckConfigs.enabled, true),
      or(eq(healthCheckConfigs.endpointId, endpointId), eq(healthCheckConfigs.poolId, poolId)),
    ));
    const endpointScoped = configs.filter((config) => config.endpointId === endpointId);
    const effective = endpointScoped.length > 0 ? endpointScoped : configs.filter((config) => config.poolId === poolId);
    if (effective.length === 0) throw new BadRequestException("该节点没有可用的健康检查配置");
    const addresses = await this.database.db.select({ id: endpointAddresses.id }).from(endpointAddresses).where(and(
      eq(endpointAddresses.endpointId, endpointId),
      eq(endpointAddresses.state, "current"),
    ));
    if (addresses.length === 0) throw new BadRequestException("该节点没有当前 IP 地址");
    const jobs = buildManualHealthJobs(endpointId, effective, addresses);
    await Promise.all(jobs.map((data) => this.queues.health.add("check-endpoint", data, {
      jobId: `manual-health-${endpointId}-${data.configId}-${data.addressId}-${randomUUID()}`,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    })));
    return { queued: jobs.length };
  }

  async createBinding(actor: AuthUser, poolId: string, input: CreateBindingInput) {
    const pool = await this.findOwnedPool(actor, poolId);
    const zone = await this.findOwnedZone(actor, input.zoneId, pool.ownerUserId);
    if (pool.strategy !== "healthy_set" && !input.originalEndpointId) throw new BadRequestException("该策略需要为域名指定原始节点");
    if (input.originalEndpointId) await this.findEndpoint(poolId, input.originalEndpointId);
    const fqdn = normalizeFqdn(input.fqdn, zone.nameAscii);
    const [existingBindings, zoneRecords] = await Promise.all([
      this.database.db.select({ id: domainBindings.id, poolId: domainBindings.poolId }).from(domainBindings).where(and(
        eq(domainBindings.zoneId, input.zoneId),
        eq(domainBindings.fqdn, fqdn),
        eq(domainBindings.recordType, input.recordType),
      )).limit(1),
      this.database.db.select().from(dnsRecords).where(and(
        eq(dnsRecords.zoneId, input.zoneId),
        sql`lower(rtrim(${dnsRecords.name}, '.')) = ${fqdn}`,
        eq(dnsRecords.type, input.recordType),
        isNull(dnsRecords.deletedAt),
      )),
    ]);
    const existingBinding = existingBindings[0];
    const existingRecords = zoneRecords;
    if (existingBinding) throw new ConflictException("该 DNS 记录已由另一个 IP Pool 管理");
    if (!input.takeoverExisting && existingRecords.length > 0) {
      throw new ConflictException("同名 DNS 记录已存在；如需纳入自动化，请启用接管现有记录");
    }
    if (input.takeoverExisting) {
      if (!input.originalEndpointId) throw new BadRequestException("接管现有记录时必须指定原始节点");
      if (existingRecords.length === 0) throw new BadRequestException("未找到可接管的同名记录，请先同步 Zone");
      if (existingRecords.length > 1) throw new ConflictException("存在多条同名记录，无法安全接管；请先整理该 RRSet");
      if (existingRecords[0]?.management !== "unmanaged") throw new ConflictException("该 DNS 记录已由其他自动化策略管理");
    }
    const { takeoverExisting, ...bindingInput } = input;
    const takeoverRecord = takeoverExisting ? existingRecords[0] : undefined;
    const binding = await this.database.db.transaction(async (tx) => {
      const [created] = await tx.insert(domainBindings).values({ ...bindingInput, fqdn, poolId }).returning();
      if (!created) throw new Error("Binding insert returned no row");
      if (input.originalEndpointId) await tx.insert(bindingAssignments).values({
        domainBindingId: created.id,
        endpointId: input.originalEndpointId,
        ...(takeoverRecord ? { dnsRecordId: takeoverRecord.id } : {}),
        desired: true,
        applied: Boolean(takeoverRecord),
        reason: "configuration",
      });
      if (takeoverRecord) {
        const [claimed] = await tx.update(dnsRecords).set({
          management: "managed",
          managedByPoolId: poolId,
          updatedAt: new Date(),
        }).where(and(
          eq(dnsRecords.id, takeoverRecord.id),
          eq(dnsRecords.management, "unmanaged"),
          isNull(dnsRecords.deletedAt),
        )).returning({ id: dnsRecords.id });
        if (!claimed) throw new ConflictException("现有 DNS 记录已被其他操作接管，请刷新后重试");
      }
      return created;
    });
    await this.recordPolicyChange(actor, poolId, "binding.create", undefined, binding);
    await this.enqueueReconcile(poolId, "configuration");
    return binding;
  }

  async updateBinding(actor: AuthUser, poolId: string, bindingId: string, input: UpdateBindingInput) {
    const pool = await this.findOwnedPool(actor, poolId);
    const current = await this.findBinding(poolId, bindingId);
    if (input.originalEndpointId) await this.findEndpoint(poolId, input.originalEndpointId);
    if (pool.strategy !== "healthy_set" && !(input.originalEndpointId ?? current.originalEndpointId)) {
      throw new BadRequestException("该策略需要为域名指定原始节点");
    }
    const { forceApply, ...fields } = input;
    const [updated] = await this.database.db.update(domainBindings).set({ ...fields, updatedAt: new Date() })
      .where(eq(domainBindings.id, bindingId)).returning();
    if (!updated) throw new Error("Binding update returned no row");
    await this.recordPolicyChange(actor, poolId, "binding.update", current, updated);
    await this.enqueueReconcile(poolId, "configuration", forceApply);
    return updated;
  }

  async deleteBinding(actor: AuthUser, poolId: string, bindingId: string) {
    const pool = await this.findOwnedPool(actor, poolId);
    const binding = await this.findBinding(poolId, bindingId);
    const published = await this.database.db.select({ assignment: bindingAssignments, record: dnsRecords })
      .from(bindingAssignments).innerJoin(dnsRecords, eq(bindingAssignments.dnsRecordId, dnsRecords.id))
      .where(and(eq(bindingAssignments.domainBindingId, bindingId), eq(bindingAssignments.applied, true)));
    if (published.length === 0) {
      await this.database.db.delete(domainBindings).where(eq(domainBindings.id, bindingId));
      await this.recordPolicyChange(actor, poolId, "binding.delete", binding, undefined, pool.ownerUserId);
      return { deleted: true };
    }
    const [zone] = await this.database.db.select({ zone: zones, providerAccountId: providerAccounts.id })
      .from(zones).innerJoin(providerAccounts, eq(zones.providerAccountId, providerAccounts.id))
      .where(eq(zones.id, binding.zoneId)).limit(1);
    if (!zone) throw new NotFoundException("绑定对应的 Zone 不存在");
    const operation = await this.database.db.transaction(async (tx) => {
      const [created] = await tx.insert(operations).values({
        ownerUserId: pool.ownerUserId,
        actorUserId: actor.id,
        source: "user",
        idempotencyKey: `binding-delete:${binding.id}:${randomUUID()}`,
        resourceType: "domain_binding",
        resourceId: binding.id,
        policyRevision: pool.policyRevision,
        beforeSnapshot: binding,
      }).returning();
      if (!created) throw new Error("Binding delete operation insert returned no row");
      await tx.insert(operationSteps).values(published.map(({ assignment, record }, index) => ({
        operationId: created.id,
        sequence: index + 1,
        providerAccountId: zone.providerAccountId,
        zoneId: zone.zone.id,
        dnsRecordId: record.id,
        action: "delete" as const,
        input: {
          zoneExternalId: zone.zone.externalId,
          recordExternalId: record.externalId,
          management: "managed",
          poolId,
          bindingId,
          endpointId: assignment.endpointId,
          assignmentMode: pool.strategy === "healthy_set" ? "set" : "single",
          deleteBinding: true,
        },
      })));
      await tx.update(domainBindings).set({ state: "switching", updatedAt: new Date() }).where(eq(domainBindings.id, bindingId));
      return created;
    });
    await this.queues.operations.add("execute-operation", { operationId: operation.id }, {
      jobId: operation.id,
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 5_000,
      removeOnFail: 5_000,
    });
    return operation;
  }

  async createHealthCheck(actor: AuthUser, poolId: string, scope: "pool" | "endpoint" | "binding", scopeId: string | undefined, config: HealthCheckConfig) {
    await this.findOwnedPool(actor, poolId);
    if (scope === "endpoint") await this.findEndpoint(poolId, requiredId(scopeId));
    if (scope === "binding") await this.findBinding(poolId, requiredId(scopeId));
    const existing = await this.database.db.select({ id: healthCheckConfigs.id }).from(healthCheckConfigs).where(and(
      eq(healthCheckConfigs.enabled, true),
      scope === "pool"
        ? eq(healthCheckConfigs.poolId, poolId)
        : scope === "endpoint"
          ? eq(healthCheckConfigs.endpointId, requiredId(scopeId))
          : eq(healthCheckConfigs.domainBindingId, requiredId(scopeId)),
    )).limit(1);
    if (existing.length > 0) throw new ConflictException("该作用域已有启用中的健康检查，请先删除或停用后再创建");
    const [created] = await this.database.db.insert(healthCheckConfigs).values({
      ...(scope === "pool" ? { poolId } : {}),
      ...(scope === "endpoint" ? { endpointId: scopeId } : {}),
      ...(scope === "binding" ? { domainBindingId: scopeId } : {}),
      checkerType: config.type,
      config,
    }).returning();
    if (!created) throw new Error("Health check insert returned no row");
    await this.recordPolicyChange(actor, poolId, "health_check.create", undefined, created);
    return created;
  }

  async deleteHealthCheck(actor: AuthUser, poolId: string, checkId: string) {
    await this.findOwnedPool(actor, poolId);
    const [check] = await this.database.db.select().from(healthCheckConfigs).where(eq(healthCheckConfigs.id, checkId)).limit(1);
    if (!check || !await this.checkBelongsToPool(check, poolId)) throw new NotFoundException("健康检查不存在");
    await this.database.db.delete(healthCheckConfigs).where(eq(healthCheckConfigs.id, checkId));
    await this.recordPolicyChange(actor, poolId, "health_check.delete", check, undefined);
    return { deleted: true };
  }

  private async findOwnedPool(actor: AuthUser, poolId: string) {
    const [pool] = await this.database.db.select().from(endpointPools).where(and(
      eq(endpointPools.id, poolId),
      actor.role === "admin" ? undefined : eq(endpointPools.ownerUserId, actor.id),
    )).limit(1);
    if (!pool) throw new NotFoundException("IP Pool 不存在");
    return pool;
  }

  private async findEndpoint(poolId: string, endpointId: string) {
    const [endpoint] = await this.database.db.select().from(endpoints).where(and(eq(endpoints.id, endpointId), eq(endpoints.poolId, poolId))).limit(1);
    if (!endpoint) throw new NotFoundException("节点不存在");
    return endpoint;
  }

  private async findBinding(poolId: string, bindingId: string) {
    const [binding] = await this.database.db.select().from(domainBindings).where(and(eq(domainBindings.id, bindingId), eq(domainBindings.poolId, poolId))).limit(1);
    if (!binding) throw new NotFoundException("域名绑定不存在");
    return binding;
  }

  private async findOwnedZone(actor: AuthUser, zoneId: string, expectedOwner: string) {
    const [row] = await this.database.db.select({ zone: zones, ownerUserId: providerAccounts.ownerUserId })
      .from(zones).innerJoin(providerAccounts, eq(zones.providerAccountId, providerAccounts.id))
      .where(and(eq(zones.id, zoneId), actor.role === "admin" ? undefined : eq(providerAccounts.ownerUserId, actor.id))).limit(1);
    if (!row || row.ownerUserId !== expectedOwner) throw new NotFoundException("域名不存在或不属于 Pool 所有者");
    return row.zone;
  }

  private async enqueueReconcile(poolId: string, trigger: PoolReconcileJob["trigger"], force = false) {
    const eventId = randomUUID();
    const revision = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${poolId}))`);
      const [pool] = await tx.update(endpointPools).set({
        decisionRevision: sql`${endpointPools.decisionRevision} + 1`,
        updatedAt: new Date(),
      }).where(eq(endpointPools.id, poolId)).returning({
        decisionRevision: endpointPools.decisionRevision,
        policyRevision: endpointPools.policyRevision,
      });
      if (!pool) throw new NotFoundException("IP Pool 不存在");
      await tx.insert(reconcileIntents).values({
        eventId,
        poolId,
        decisionRevision: pool.decisionRevision,
        policyRevision: pool.policyRevision,
        trigger,
        source: "user",
        force,
      });
      return pool;
    });
    return { queued: true, eventId, ...revision };
  }

  private async recordPolicyChange(actor: AuthUser, poolId: string, reason: string, before: unknown, after: unknown, ownerOverride?: string) {
    return this.database.db.transaction(async (tx) => {
      const [pool] = await tx.update(endpointPools).set({ policyRevision: sql`${endpointPools.policyRevision} + 1`, updatedAt: new Date() })
        .where(eq(endpointPools.id, poolId)).returning();
      if (!pool) throw new NotFoundException("IP Pool 不存在");
      const [endpointRows, addresses, bindings, checks] = await Promise.all([
        tx.select().from(endpoints).where(eq(endpoints.poolId, poolId)),
        tx.select({ address: endpointAddresses }).from(endpointAddresses).innerJoin(endpoints, eq(endpointAddresses.endpointId, endpoints.id)).where(eq(endpoints.poolId, poolId)),
        tx.select().from(domainBindings).where(eq(domainBindings.poolId, poolId)),
        tx.select().from(healthCheckConfigs).where(or(
          eq(healthCheckConfigs.poolId, poolId),
          inArray(healthCheckConfigs.endpointId, tx.select({ id: endpoints.id }).from(endpoints).where(eq(endpoints.poolId, poolId))),
          inArray(healthCheckConfigs.domainBindingId, tx.select({ id: domainBindings.id }).from(domainBindings).where(eq(domainBindings.poolId, poolId))),
        )),
      ]);
      const snapshot = { pool, endpoints: endpointRows, addresses: addresses.map((row) => row.address), bindings, healthChecks: checks };
      await tx.insert(policyVersions).values({ poolId, version: pool.policyRevision, snapshot, reason, actorUserId: actor.id });
      await tx.insert(auditLogs).values({
        ownerUserId: ownerOverride ?? pool.ownerUserId,
        actorUserId: actor.id,
        source: "user",
        action: reason,
        resourceType: reason.split(".")[0] ?? "endpoint_pool",
        resourceId: poolId,
        beforeSnapshot: before,
        afterSnapshot: after,
      });
      return pool;
    });
  }

  private async checkBelongsToPool(check: typeof healthCheckConfigs.$inferSelect, poolId: string) {
    if (check.poolId) return check.poolId === poolId;
    if (check.endpointId) return Boolean((await this.database.db.select({ id: endpoints.id }).from(endpoints).where(and(eq(endpoints.id, check.endpointId), eq(endpoints.poolId, poolId))).limit(1))[0]);
    if (check.domainBindingId) return Boolean((await this.database.db.select({ id: domainBindings.id }).from(domainBindings).where(and(eq(domainBindings.id, check.domainBindingId), eq(domainBindings.poolId, poolId))).limit(1))[0]);
    return false;
  }
}

export function buildManualHealthJobs(
  endpointId: string,
  configs: Pick<typeof healthCheckConfigs.$inferSelect, "id">[],
  addresses: Pick<typeof endpointAddresses.$inferSelect, "id">[],
): HealthCheckJob[] {
  return configs.flatMap((config) => addresses.map((address) => ({
    endpointId,
    configId: config.id,
    addressId: address.id,
    manual: true,
  })));
}

async function replaceStaticAddress(
  tx: DatabaseTransaction,
  endpointId: string,
  family: "4" | "6",
  address: string | null,
): Promise<boolean> {
  const [current] = await tx.select().from(endpointAddresses).where(and(
    eq(endpointAddresses.endpointId, endpointId),
    eq(endpointAddresses.family, family),
    eq(endpointAddresses.state, "current"),
  )).limit(1);
  if (current?.address === address && current.source === "static") return false;
  if (!current && address === null) return false;
  if (current?.address === address) {
    await tx.update(endpointAddresses).set({
      source: "static",
      healthState: "unknown",
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      lastCheckedAt: null,
      observedAt: new Date(),
    }).where(eq(endpointAddresses.id, current.id));
    return true;
  }
  if (current) await tx.update(endpointAddresses).set({ state: "previous", replacedAt: new Date() }).where(eq(endpointAddresses.id, current.id));
  if (address) await tx.insert(endpointAddresses).values({ endpointId, family, address, state: "current", source: "static", promotedAt: new Date() });
  return true;
}

async function disableDdnsAgent(
  tx: DatabaseTransaction,
  endpointId: string,
  now: Date,
): Promise<void> {
  await tx.update(ddnsAgents).set({
    installTokenHash: null,
    installTokenExpiresAt: null,
    runtimeTokenHash: null,
    previousRuntimeTokenHash: null,
    previousRuntimeTokenExpiresAt: null,
    status: "disabled",
    revokedAt: now,
    updatedAt: now,
  }).where(eq(ddnsAgents.endpointId, endpointId));
}

export async function restoreEndpointPolicy(
  tx: DatabaseTransaction,
  poolId: string,
  endpoint: PolicySnapshot["endpoints"][number],
  addresses: PolicySnapshot["addresses"],
  restoredAt: Date,
): Promise<void> {
  const [lockedEndpoint] = await tx.select({ id: endpoints.id, addressMode: endpoints.addressMode })
    .from(endpoints).where(and(eq(endpoints.id, endpoint.id), eq(endpoints.poolId, poolId)))
    .limit(1).for("update");
  if (!lockedEndpoint) throw new ConflictException(`节点 ${endpoint.name} 已被删除，无法完成策略回滚`);

  const modeChanged = lockedEndpoint.addressMode !== endpoint.addressMode;
  if (endpoint.addressMode === "static" || modeChanged) {
    await tx.select({ id: ddnsAgents.id }).from(ddnsAgents)
      .where(eq(ddnsAgents.endpointId, endpoint.id)).limit(1).for("update");
    await disableDdnsAgent(tx, endpoint.id, restoredAt);
  }

  const resetHealth = {
    healthState: "unknown" as const,
    consecutiveSuccesses: 0,
    consecutiveFailures: 0,
    lastCheckedAt: null,
  };
  if (endpoint.addressMode === "static") {
    await tx.update(endpointAddresses).set({
      state: "previous",
      replacedAt: restoredAt,
      ...resetHealth,
    }).where(and(
      eq(endpointAddresses.endpointId, endpoint.id),
      inArray(endpointAddresses.state, ["candidate", "current"]),
    ));
    const desired = addresses.filter((address) => (
      address.endpointId === endpoint.id
      && address.state === "current"
      && address.source === "static"
    ));
    if (desired.length > 0) {
      await tx.insert(endpointAddresses).values(desired.map((address) => ({
        endpointId: endpoint.id,
        family: address.family,
        address: address.address,
        state: "current" as const,
        source: "static" as const,
        healthState: "unknown" as const,
        consecutiveSuccesses: 0,
        consecutiveFailures: 0,
        lastCheckedAt: null,
        observedAt: restoredAt,
        promotedAt: restoredAt,
      })));
    }
  } else if (modeChanged) {
    await tx.update(endpointAddresses).set({
      state: "previous",
      replacedAt: restoredAt,
      ...resetHealth,
    }).where(and(
      eq(endpointAddresses.endpointId, endpoint.id),
      inArray(endpointAddresses.state, ["candidate", "current"]),
    ));
  } else {
    await tx.update(endpointAddresses).set(resetHealth).where(and(
      eq(endpointAddresses.endpointId, endpoint.id),
      inArray(endpointAddresses.state, ["candidate", "current"]),
    ));
  }

  await tx.update(endpoints).set({
    name: endpoint.name,
    addressMode: endpoint.addressMode,
    priority: endpoint.priority,
    lifecycle: endpoint.lifecycle,
    ...resetHealth,
    stateChangedAt: restoredAt,
    updatedAt: restoredAt,
  }).where(and(eq(endpoints.id, endpoint.id), eq(endpoints.poolId, poolId)));
}

function normalizeFqdn(value: string, zoneName: string): string {
  const name = value.replace(/\.$/, "").toLowerCase();
  const zone = zoneName.replace(/\.$/, "").toLowerCase();
  if (name === "@" || name === zone) return zone;
  if (name.endsWith(`.${zone}`)) return name;
  if (!name.includes(".")) return `${name}.${zone}`;
  throw new BadRequestException("域名绑定不属于所选 Zone");
}

function requiredId(value: string | undefined): string {
  if (!value) throw new BadRequestException("缺少资源 ID");
  return value;
}

function sameIdSet(left: Array<{ id: string }>, right: Array<{ id: string }>): boolean {
  if (left.length !== right.length) return false;
  const ids = new Set(left.map((item) => item.id));
  return right.every((item) => ids.has(item.id));
}
