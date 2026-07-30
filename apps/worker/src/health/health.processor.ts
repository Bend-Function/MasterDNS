import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { applyHealthResult } from "@masterdns/automation";
import { CheckerRegistry } from "@masterdns/checkers";
import type { HealthCheckConfig, HealthCheckJob, HealthState, PoolReconcileJob } from "@masterdns/contracts";
import { healthCheckConfigSchema, queueNames } from "@masterdns/contracts";
import {
  bindingEndpointHealth,
  ddnsAgents,
  domainBindings,
  endpointAddresses,
  endpointPools,
  endpoints,
  healthCheckConfigs,
  healthCheckResults,
  reconcileIntents,
} from "@masterdns/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { Job, Worker } from "bullmq";
import { DatabaseService } from "../database.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";

@Injectable()
export class HealthProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthProcessor.name);
  private readonly registry = new CheckerRegistry(undefined, { allowPrivate: process.env.ALLOW_PRIVATE_HEALTH_TARGETS === "true" });
  private worker?: Worker<HealthCheckJob>;

  constructor(private readonly database: DatabaseService, private readonly queues: QueueRuntimeService) {}

  onModuleInit() {
    this.worker = new Worker<HealthCheckJob>(queueNames.health, (job) => this.process(job), {
      connection: this.queues.redis,
      concurrency: 20,
      lockDuration: 70_000,
    });
    this.worker.on("failed", (job, error) => this.logger.error(`Health job ${job?.id ?? "unknown"} failed: ${safeError(error)}`));
  }

  async onModuleDestroy() { await this.worker?.close(); }

  private async process(job: Job<HealthCheckJob>) {
    const target = await this.loadTarget(job.data);
    if (!target) return;
    const config = healthCheckConfigSchema.parse(target.config.config);
    if (config.type !== target.config.checkerType) throw new Error("Health checker type does not match its config");
    const lockKey = ["masterdns", "health-lock", target.endpoint.id, target.config.id, target.binding?.id ?? "base", target.address.id].join(":");
    const lockToken = randomUUID();
    const acquired = await this.queues.redis.set(lockKey, lockToken, "PX", config.timeoutMs + 5_000, "NX");
    if (acquired !== "OK") return;
    try {
    const checker = this.registry.get(config.type);
    const port = config.type === "tcp" ? config.port : config.port ?? (config.protocol === "https" ? 443 : 80);
    const hostname = config.type === "http" ? config.hostname ?? target.binding?.fqdn : undefined;
    const result = await checker.check({
      address: target.address.address,
      port,
      family: target.address.family === "4" ? 4 : 6,
      ...(hostname ? { hostname } : {}),
    }, config as never);

    const eventId = randomUUID();
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${target.pool.id}))`);
      await tx.execute(sql`select id from endpoints where id = ${target.endpoint.id} for update`);
      await tx.execute(sql`select id from endpoint_addresses where id = ${target.address.id} for update`);
      const [current] = await tx.select().from(endpoints).where(eq(endpoints.id, target.endpoint.id)).limit(1);
      if (!current) return null;
      const [currentAddress] = await tx.select().from(endpointAddresses).where(eq(endpointAddresses.id, target.address.id)).limit(1);
      if (!currentAddress || !isAddressStillIntended(target.address, currentAddress, current.addressMode)) return null;
      const [currentConfig] = await tx.select().from(healthCheckConfigs).where(eq(healthCheckConfigs.id, target.config.id)).limit(1);
      if (!isHealthCheckDefinitionCurrent(target.config, currentConfig)) return null;
      const [currentPool] = await tx.select().from(endpointPools).where(eq(endpointPools.id, target.pool.id)).limit(1);
      if (!currentPool) return null;
      const [bindingHealth] = target.binding
        ? await tx.select().from(bindingEndpointHealth).where(and(
          eq(bindingEndpointHealth.domainBindingId, target.binding.id),
          eq(bindingEndpointHealth.endpointId, current.id),
        )).limit(1)
        : [];
      const currentBindingHealth = isBindingHealthForAddress(bindingHealth, currentAddress.id) ? bindingHealth : undefined;
      const checkingCandidate = currentAddress.state === "candidate" && !target.binding;
      const observation = checkingCandidate
        ? { state: currentAddress.healthState, consecutiveSuccesses: currentAddress.consecutiveSuccesses, consecutiveFailures: currentAddress.consecutiveFailures }
        : currentBindingHealth
          ? { state: currentBindingHealth.healthState, consecutiveSuccesses: currentBindingHealth.consecutiveSuccesses, consecutiveFailures: currentBindingHealth.consecutiveFailures }
          : target.binding
            ? { state: "unknown" as const, consecutiveSuccesses: 0, consecutiveFailures: 0 }
            : { state: currentAddress.healthState, consecutiveSuccesses: currentAddress.consecutiveSuccesses, consecutiveFailures: currentAddress.consecutiveFailures };
      const next = applyHealthResult(observation, result.success, {
        failureThreshold: currentPool.failureThreshold,
        successThreshold: currentPool.successThreshold,
      });

      await tx.insert(healthCheckResults).values({
        configId: target.config.id,
        endpointId: current.id,
        endpointAddressId: currentAddress.id,
        ...(target.binding ? { domainBindingId: target.binding.id } : {}),
        probeId: "local",
        success: result.success,
        latencyMs: result.latencyMs,
        statusCode: result.statusCode ?? null,
        errorCode: result.errorCode ?? null,
        errorDetail: result.errorDetail?.slice(0, 512) ?? null,
        checkedAt: result.checkedAt,
      });
      if (checkingCandidate) {
        await tx.update(endpointAddresses).set({
          healthState: next.state,
          consecutiveSuccesses: next.consecutiveSuccesses,
          consecutiveFailures: next.consecutiveFailures,
          lastCheckedAt: result.checkedAt,
        }).where(and(eq(endpointAddresses.id, currentAddress.id), eq(endpointAddresses.state, "candidate")));
      } else if (target.binding) {
        await tx.insert(bindingEndpointHealth).values({
          domainBindingId: target.binding.id,
          endpointId: current.id,
          endpointAddressId: currentAddress.id,
          healthState: next.state,
          consecutiveSuccesses: next.consecutiveSuccesses,
          consecutiveFailures: next.consecutiveFailures,
          lastCheckedAt: result.checkedAt,
          stateChangedAt: next.state !== observation.state ? result.checkedAt : currentBindingHealth?.stateChangedAt ?? result.checkedAt,
        }).onConflictDoUpdate({
          target: [bindingEndpointHealth.domainBindingId, bindingEndpointHealth.endpointId],
          set: {
            healthState: next.state,
            endpointAddressId: currentAddress.id,
            consecutiveSuccesses: next.consecutiveSuccesses,
            consecutiveFailures: next.consecutiveFailures,
            lastCheckedAt: result.checkedAt,
            ...(next.state !== observation.state ? { stateChangedAt: result.checkedAt } : {}),
            updatedAt: new Date(),
          },
        });
      } else {
        await tx.update(endpointAddresses).set({
          healthState: next.state,
          consecutiveSuccesses: next.consecutiveSuccesses,
          consecutiveFailures: next.consecutiveFailures,
          lastCheckedAt: result.checkedAt,
        }).where(and(eq(endpointAddresses.id, currentAddress.id), eq(endpointAddresses.state, "current")));
      }

      let promoted = false;
      if (checkingCandidate && next.state === "healthy") {
        await tx.update(endpointAddresses).set({
          state: "previous",
          replacedAt: new Date(),
        }).where(and(
          eq(endpointAddresses.endpointId, current.id),
          eq(endpointAddresses.family, currentAddress.family),
          eq(endpointAddresses.state, "current"),
          ne(endpointAddresses.id, currentAddress.id),
        ));
        await tx.update(endpointAddresses).set({ state: "current", promotedAt: new Date() })
          .where(and(
            eq(endpointAddresses.id, currentAddress.id),
            eq(endpointAddresses.state, "candidate"),
            eq(endpointAddresses.source, "ddns"),
          ));
        await tx.update(ddnsAgents).set({ lastIpChangedAt: new Date(), updatedAt: new Date() })
          .where(eq(ddnsAgents.endpointId, current.id));
        promoted = true;
      }

      if (!target.binding && (!checkingCandidate || promoted)) {
        const currentAddresses = await tx.select({
          healthState: endpointAddresses.healthState,
          consecutiveSuccesses: endpointAddresses.consecutiveSuccesses,
          consecutiveFailures: endpointAddresses.consecutiveFailures,
          lastCheckedAt: endpointAddresses.lastCheckedAt,
        }).from(endpointAddresses).where(and(
          eq(endpointAddresses.endpointId, current.id),
          eq(endpointAddresses.state, "current"),
        ));
        const endpointState = aggregatePoolState(currentAddresses.map((address) => address.healthState));
        await tx.update(endpoints).set({
          healthState: endpointState,
          consecutiveSuccesses: currentAddresses.length > 0 ? Math.min(...currentAddresses.map((address) => address.consecutiveSuccesses)) : 0,
          consecutiveFailures: currentAddresses.length > 0 ? Math.max(...currentAddresses.map((address) => address.consecutiveFailures)) : 0,
          lastCheckedAt: latestDate(currentAddresses.map((address) => address.lastCheckedAt)),
          ...(endpointState !== current.healthState ? { stateChangedAt: result.checkedAt } : {}),
          updatedAt: new Date(),
        }).where(eq(endpoints.id, current.id));
      }

      if (target.binding) {
        const bindingStates = await tx.select({
          state: bindingEndpointHealth.healthState,
          endpointId: bindingEndpointHealth.endpointId,
          endpointAddressId: bindingEndpointHealth.endpointAddressId,
          recordType: domainBindings.recordType,
        })
          .from(bindingEndpointHealth)
          .innerJoin(domainBindings, eq(bindingEndpointHealth.domainBindingId, domainBindings.id))
          .where(eq(domainBindings.poolId, currentPool.id));
        const currentAddresses = await tx.select({
          id: endpointAddresses.id,
          endpointId: endpointAddresses.endpointId,
          family: endpointAddresses.family,
        }).from(endpointAddresses)
          .innerJoin(endpoints, eq(endpointAddresses.endpointId, endpoints.id))
          .where(and(eq(endpoints.poolId, currentPool.id), eq(endpointAddresses.state, "current")));
        const currentAddressIds = new Set(currentAddresses.map((address) => `${address.endpointId}:${address.family}:${address.id}`));
        const currentBindingStates = bindingStates.filter((item) => item.endpointAddressId
          && currentAddressIds.has(`${item.endpointId}:${item.recordType === "AAAA" ? "6" : "4"}:${item.endpointAddressId}`));
        await tx.update(endpointPools).set({
          state: aggregatePoolState(currentBindingStates.map((item) => item.state)),
          updatedAt: new Date(),
        }).where(eq(endpointPools.id, currentPool.id));
      } else if (!checkingCandidate || promoted) {
        const poolEndpoints = await tx.select({ state: endpoints.healthState }).from(endpoints)
          .where(eq(endpoints.poolId, currentPool.id));
        await tx.update(endpointPools).set({ state: aggregatePoolState(poolEndpoints.map((item) => item.state)), updatedAt: new Date() })
          .where(eq(endpointPools.id, currentPool.id));
      }

      const transition = promoted
        ? { trigger: "repair" as const }
        : checkingCandidate || next.state === observation.state
          ? null
          : next.state === "unhealthy"
            ? { trigger: "failure" as const }
            : next.state === "healthy" && observation.state !== "healthy"
              ? { trigger: "recovery" as const }
              : null;
      if (!transition) return null;
      const source = promoted && currentAddress.source === "ddns"
        ? "ddns" as const
        : transition.trigger === "recovery" ? "recovery" as const : "failover" as const;
      const delay = recoveryReconcileDelayMs({
        trigger: transition.trigger,
        recoveryMode: currentPool.recoveryMode,
        recoveryDelaySeconds: currentPool.recoveryDelaySeconds,
        switchCooldownSeconds: currentPool.switchCooldownSeconds,
        lastReconciledAt: currentPool.lastReconciledAt,
      });
      const [sequencedPool] = await tx.update(endpointPools).set({
        decisionRevision: sql`${endpointPools.decisionRevision} + 1`,
        updatedAt: new Date(),
      }).where(eq(endpointPools.id, currentPool.id)).returning({
        decisionRevision: endpointPools.decisionRevision,
        policyRevision: endpointPools.policyRevision,
      });
      if (!sequencedPool) throw new Error("Pool decision revision update returned no row");
      await tx.insert(reconcileIntents).values({
        eventId,
        poolId: currentPool.id,
        endpointId: current.id,
        decisionRevision: sequencedPool.decisionRevision,
        policyRevision: sequencedPool.policyRevision,
        trigger: transition.trigger,
        source,
        availableAt: new Date(Date.now() + delay),
      });
      return transition;
    });
    } finally {
      await this.queues.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        lockKey,
        lockToken,
      );
    }
  }

  private async loadTarget(job: HealthCheckJob) {
    const [endpoint] = await this.database.db.select().from(endpoints).where(eq(endpoints.id, job.endpointId)).limit(1);
    if (!endpoint) return null;
    const [[pool], [config], bindingRows] = await Promise.all([
      this.database.db.select().from(endpointPools).where(eq(endpointPools.id, endpoint.poolId)).limit(1),
      this.database.db.select().from(healthCheckConfigs).where(and(eq(healthCheckConfigs.id, job.configId), eq(healthCheckConfigs.enabled, true))).limit(1),
      job.bindingId
        ? this.database.db.select().from(domainBindings).where(and(eq(domainBindings.id, job.bindingId), eq(domainBindings.poolId, endpoint.poolId))).limit(1)
        : Promise.resolve([]),
    ]);
    const binding = bindingRows[0];
    const family = binding ? (binding.recordType === "AAAA" ? "6" : "4") : undefined;
    const addressRows = job.addressId
      ? await this.database.db.select().from(endpointAddresses).where(and(eq(endpointAddresses.id, job.addressId), eq(endpointAddresses.endpointId, endpoint.id))).limit(1)
      : await this.database.db.select().from(endpointAddresses).where(and(
        eq(endpointAddresses.endpointId, endpoint.id),
        eq(endpointAddresses.state, "current"),
        family ? eq(endpointAddresses.family, family) : undefined,
      )).limit(1);
    const address = addressRows[0];
    if (!pool || !config || !address) return null;
    return { endpoint, pool, config, binding, address };
  }
}

export function isAddressStillIntended(
  observed: Pick<typeof endpointAddresses.$inferSelect, "id" | "endpointId" | "address" | "family" | "state" | "source">,
  current: Pick<typeof endpointAddresses.$inferSelect, "id" | "endpointId" | "address" | "family" | "state" | "source">,
  endpointMode: typeof endpoints.$inferSelect["addressMode"],
): boolean {
  if (observed.id !== current.id
    || observed.endpointId !== current.endpointId
    || observed.address !== current.address
    || observed.family !== current.family
    || observed.source !== current.source) return false;
  if (observed.state === "candidate") return endpointMode === "ddns" && current.state === "candidate" && current.source === "ddns";
  return current.state === "current" && current.source === endpointMode;
}

export function isHealthCheckDefinitionCurrent(
  observed: Pick<typeof healthCheckConfigs.$inferSelect, "id" | "revision" | "enabled" | "updatedAt">,
  current: Pick<typeof healthCheckConfigs.$inferSelect, "id" | "revision" | "enabled" | "updatedAt"> | undefined,
): boolean {
  return Boolean(current
    && current.id === observed.id
    && current.enabled
    && current.revision === observed.revision
    && current.updatedAt.getTime() === observed.updatedAt.getTime());
}

export function isBindingHealthForAddress(
  health: Pick<typeof bindingEndpointHealth.$inferSelect, "endpointAddressId"> | undefined,
  addressId: string,
): boolean {
  return health?.endpointAddressId === addressId;
}

export function recoveryReconcileDelayMs(input: {
  trigger: PoolReconcileJob["trigger"];
  recoveryMode: "automatic" | "keep_current" | "manual" | "delayed";
  recoveryDelaySeconds: number;
  switchCooldownSeconds: number;
  lastReconciledAt: Date | null;
}, now = Date.now()): number {
  if (input.trigger !== "recovery") return 0;
  const configuredRecoveryDelay = input.recoveryMode === "delayed" ? input.recoveryDelaySeconds * 1000 : 0;
  const cooldownRemaining = input.lastReconciledAt
    ? Math.max(0, input.lastReconciledAt.getTime() + input.switchCooldownSeconds * 1000 - now)
    : 0;
  return Math.max(configuredRecoveryDelay, cooldownRemaining);
}

export function aggregatePoolState(states: HealthState[]): HealthState {
  if (states.length === 0 || states.every((state) => state === "unknown")) return "unknown";
  const healthy = states.filter((state) => state === "healthy").length;
  if (healthy === states.length) return "healthy";
  if (healthy > 0) return "degraded";
  if (states.some((state) => state === "recovering")) return "recovering";
  if (states.some((state) => state === "degraded")) return "degraded";
  return "unhealthy";
}

function latestDate(values: Array<Date | null>): Date | null {
  const timestamps = values.flatMap((value) => value ? [value.getTime()] : []);
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown";
}
