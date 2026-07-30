import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { HealthCheckConfig, PoolReconcileJob } from "@masterdns/contracts";
import {
  auditLogs,
  bindingAssignments,
  ddnsAgents,
  domainBindings,
  endpointAddresses,
  endpointPools,
  endpoints,
  failoverEvents,
  healthCheckConfigs,
  healthCheckResults,
  policyVersions,
  providerAccounts,
  zones,
} from "@masterdns/db";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
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
    const [updated] = await this.database.db.update(endpointPools).set({ ...input, updatedAt: new Date() }).where(eq(endpointPools.id, poolId)).returning();
    if (!updated) throw new Error("Pool update returned no row");
    await this.recordPolicyChange(actor, poolId, "pool.update", current, updated);
    await this.enqueueReconcile(poolId, "configuration");
    return updated;
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
    const { ipv4, ipv6, forceApply, ...fields } = input;
    const updated = await this.database.db.transaction(async (tx) => {
      let addressChanged = false;
      if (ipv4 !== undefined || ipv6 !== undefined) {
        if (current.addressMode !== "static") throw new ConflictException("DDNS 节点地址只能由 Agent 上报");
        if (ipv4 !== undefined) addressChanged = await replaceStaticAddress(tx, endpointId, "4", ipv4) || addressChanged;
        if (ipv6 !== undefined) addressChanged = await replaceStaticAddress(tx, endpointId, "6", ipv6) || addressChanged;
        const remaining = await tx.select({ id: endpointAddresses.id }).from(endpointAddresses)
          .where(and(eq(endpointAddresses.endpointId, endpointId), eq(endpointAddresses.state, "current")));
        if (remaining.length === 0) throw new BadRequestException("静态节点至少需要一个当前 IP 地址");
      }
      const [row] = await tx.update(endpoints).set({
        ...fields,
        ...(addressChanged ? { healthState: "unknown" as const, consecutiveSuccesses: 0, consecutiveFailures: 0, stateChangedAt: new Date() } : {}),
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
      this.database.db.select({ id: bindingAssignments.endpointId }).from(bindingAssignments).where(eq(bindingAssignments.endpointId, endpointId)).limit(1),
      this.database.db.select({ id: domainBindings.id }).from(domainBindings).where(eq(domainBindings.originalEndpointId, endpointId)).limit(1),
    ]);
    if (assignment.length > 0 || binding.length > 0) throw new ConflictException("节点仍被域名绑定引用，请先调整绑定或重新平衡");
    await this.database.db.delete(endpoints).where(eq(endpoints.id, endpointId));
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
    await Promise.all(effective.map((config) => this.queues.health.add("check-endpoint", { endpointId, configId: config.id, manual: true }, {
      jobId: `manual-health-${endpointId}-${config.id}-${randomUUID()}`,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    })));
    return { queued: effective.length };
  }

  async createBinding(actor: AuthUser, poolId: string, input: CreateBindingInput) {
    const pool = await this.findOwnedPool(actor, poolId);
    const zone = await this.findOwnedZone(actor, input.zoneId, pool.ownerUserId);
    if (pool.strategy !== "healthy_set" && !input.originalEndpointId) throw new BadRequestException("该策略需要为域名指定原始节点");
    if (input.originalEndpointId) await this.findEndpoint(poolId, input.originalEndpointId);
    const fqdn = normalizeFqdn(input.fqdn, zone.nameAscii);
    const binding = await this.database.db.transaction(async (tx) => {
      const [created] = await tx.insert(domainBindings).values({ ...input, fqdn, poolId }).returning();
      if (!created) throw new Error("Binding insert returned no row");
      if (input.originalEndpointId) await tx.insert(bindingAssignments).values({
        domainBindingId: created.id,
        endpointId: input.originalEndpointId,
        desired: true,
        applied: false,
        reason: "configuration",
      });
      return created;
    });
    await this.recordPolicyChange(actor, poolId, "binding.create", undefined, binding);
    await this.enqueueReconcile(poolId, "configuration");
    return binding;
  }

  async updateBinding(actor: AuthUser, poolId: string, bindingId: string, input: UpdateBindingInput) {
    await this.findOwnedPool(actor, poolId);
    const current = await this.findBinding(poolId, bindingId);
    if (input.originalEndpointId) await this.findEndpoint(poolId, input.originalEndpointId);
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
    const applied = await this.database.db.select({ id: bindingAssignments.dnsRecordId }).from(bindingAssignments)
      .where(and(eq(bindingAssignments.domainBindingId, bindingId), eq(bindingAssignments.applied, true))).limit(1);
    if (applied.length > 0) throw new ConflictException("该绑定仍有已发布 DNS 记录，请先暂停并解除发布后再删除");
    await this.database.db.delete(domainBindings).where(eq(domainBindings.id, bindingId));
    await this.recordPolicyChange(actor, poolId, "binding.delete", binding, undefined, pool.ownerUserId);
    return { deleted: true };
  }

  async createHealthCheck(actor: AuthUser, poolId: string, scope: "pool" | "endpoint" | "binding", scopeId: string | undefined, config: HealthCheckConfig) {
    await this.findOwnedPool(actor, poolId);
    if (scope === "endpoint") await this.findEndpoint(poolId, requiredId(scopeId));
    if (scope === "binding") await this.findBinding(poolId, requiredId(scopeId));
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
    await this.queues.reconcile.add("reconcile-pool", { poolId, eventId, trigger, force }, {
      jobId: `reconcile-${eventId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 5_000,
      removeOnFail: 5_000,
    });
    return { queued: true, eventId };
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

async function replaceStaticAddress(
  tx: Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0],
  endpointId: string,
  family: "4" | "6",
  address: string | null,
): Promise<boolean> {
  const [current] = await tx.select().from(endpointAddresses).where(and(
    eq(endpointAddresses.endpointId, endpointId),
    eq(endpointAddresses.family, family),
    eq(endpointAddresses.state, "current"),
  )).limit(1);
  if (current?.address === address) return false;
  if (current) await tx.update(endpointAddresses).set({ state: "previous", replacedAt: new Date() }).where(eq(endpointAddresses.id, current.id));
  if (address) await tx.insert(endpointAddresses).values({ endpointId, family, address, state: "current", source: "static", promotedAt: new Date() });
  return true;
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
