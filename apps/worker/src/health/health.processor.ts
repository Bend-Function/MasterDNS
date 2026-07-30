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
} from "@masterdns/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { Job, Worker } from "bullmq";
import { DatabaseService } from "../database.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";

@Injectable()
export class HealthProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthProcessor.name);
  private readonly registry = new CheckerRegistry();
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

    const transition = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from endpoints where id = ${target.endpoint.id} for update`);
      const [current] = await tx.select().from(endpoints).where(eq(endpoints.id, target.endpoint.id)).limit(1);
      if (!current) return null;
      const [bindingHealth] = target.binding
        ? await tx.select().from(bindingEndpointHealth).where(and(
          eq(bindingEndpointHealth.domainBindingId, target.binding.id),
          eq(bindingEndpointHealth.endpointId, current.id),
        )).limit(1)
        : [];
      const checkingCandidate = target.address.state === "candidate" && !target.binding;
      const observation = checkingCandidate
        ? { state: target.address.healthState, consecutiveSuccesses: target.address.consecutiveSuccesses, consecutiveFailures: target.address.consecutiveFailures }
        : bindingHealth
          ? { state: bindingHealth.healthState, consecutiveSuccesses: bindingHealth.consecutiveSuccesses, consecutiveFailures: bindingHealth.consecutiveFailures }
          : target.binding
            ? { state: "unknown" as const, consecutiveSuccesses: 0, consecutiveFailures: 0 }
            : { state: current.healthState, consecutiveSuccesses: current.consecutiveSuccesses, consecutiveFailures: current.consecutiveFailures };
      const next = applyHealthResult(observation, result.success, {
        failureThreshold: target.pool.failureThreshold,
        successThreshold: target.pool.successThreshold,
      });

      await tx.insert(healthCheckResults).values({
        configId: target.config.id,
        endpointId: current.id,
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
        }).where(eq(endpointAddresses.id, target.address.id));
      } else if (target.binding) {
        await tx.insert(bindingEndpointHealth).values({
          domainBindingId: target.binding.id,
          endpointId: current.id,
          healthState: next.state,
          consecutiveSuccesses: next.consecutiveSuccesses,
          consecutiveFailures: next.consecutiveFailures,
          lastCheckedAt: result.checkedAt,
          stateChangedAt: next.state !== observation.state ? result.checkedAt : bindingHealth?.stateChangedAt ?? result.checkedAt,
        }).onConflictDoUpdate({
          target: [bindingEndpointHealth.domainBindingId, bindingEndpointHealth.endpointId],
          set: {
            healthState: next.state,
            consecutiveSuccesses: next.consecutiveSuccesses,
            consecutiveFailures: next.consecutiveFailures,
            lastCheckedAt: result.checkedAt,
            ...(next.state !== observation.state ? { stateChangedAt: result.checkedAt } : {}),
            updatedAt: new Date(),
          },
        });
      } else {
        await tx.update(endpoints).set({
          healthState: next.state,
          consecutiveSuccesses: next.consecutiveSuccesses,
          consecutiveFailures: next.consecutiveFailures,
          lastCheckedAt: result.checkedAt,
          ...(next.state !== current.healthState ? { stateChangedAt: result.checkedAt } : {}),
          updatedAt: new Date(),
        }).where(eq(endpoints.id, current.id));
      }

      let promoted = false;
      if (checkingCandidate && next.state === "healthy") {
        await tx.update(endpointAddresses).set({
          state: "previous",
          replacedAt: new Date(),
        }).where(and(
          eq(endpointAddresses.endpointId, current.id),
          eq(endpointAddresses.family, target.address.family),
          eq(endpointAddresses.state, "current"),
          ne(endpointAddresses.id, target.address.id),
        ));
        await tx.update(endpointAddresses).set({ state: "current", promotedAt: new Date() })
          .where(eq(endpointAddresses.id, target.address.id));
        await tx.update(ddnsAgents).set({ lastIpChangedAt: new Date(), updatedAt: new Date() })
          .where(eq(ddnsAgents.endpointId, current.id));
        await tx.update(endpoints).set({
          healthState: "healthy",
          consecutiveSuccesses: next.consecutiveSuccesses,
          consecutiveFailures: 0,
          lastCheckedAt: result.checkedAt,
          stateChangedAt: current.healthState === "healthy" ? current.stateChangedAt : result.checkedAt,
          updatedAt: new Date(),
        }).where(eq(endpoints.id, current.id));
        promoted = true;
      } else if (checkingCandidate && next.state === "unhealthy" && observation.state !== "unhealthy") {
        await tx.update(endpoints).set({
          healthState: "unhealthy",
          consecutiveSuccesses: 0,
          consecutiveFailures: next.consecutiveFailures,
          lastCheckedAt: result.checkedAt,
          stateChangedAt: result.checkedAt,
          updatedAt: new Date(),
        }).where(eq(endpoints.id, current.id));
      }

      if (!target.binding) {
        const poolEndpoints = await tx.select({ state: endpoints.healthState }).from(endpoints)
          .where(eq(endpoints.poolId, target.pool.id));
        await tx.update(endpointPools).set({ state: aggregatePoolState(poolEndpoints.map((item) => item.state)), updatedAt: new Date() })
          .where(eq(endpointPools.id, target.pool.id));
      }

      if (promoted) return { trigger: "repair" as const, previous: observation.state, next: next.state };
      if (next.state === observation.state) return null;
      if (next.state === "unhealthy") return { trigger: "failure" as const, previous: observation.state, next: next.state };
      if (next.state === "healthy" && observation.state !== "healthy") return { trigger: "recovery" as const, previous: observation.state, next: next.state };
      return null;
    });

    if (transition) {
      const eventId = randomUUID();
      const data: PoolReconcileJob = {
        poolId: target.pool.id,
        eventId,
        trigger: transition.trigger,
        source: target.address.state === "candidate" && target.address.source === "ddns"
          ? "ddns"
          : transition.trigger === "recovery" ? "recovery" : "failover",
        endpointId: target.endpoint.id,
      };
      const delay = recoveryReconcileDelayMs({
        trigger: transition.trigger,
        recoveryMode: target.pool.recoveryMode,
        recoveryDelaySeconds: target.pool.recoveryDelaySeconds,
        switchCooldownSeconds: target.pool.switchCooldownSeconds,
        lastReconciledAt: target.pool.lastReconciledAt,
      });
      await this.queues.reconcile.add("reconcile-pool", data, {
        jobId: `reconcile-${eventId}`,
        delay,
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: 5_000,
        removeOnFail: 5_000,
      });
    }
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
    const [[pool], [config], bindingRows, addressRows] = await Promise.all([
      this.database.db.select().from(endpointPools).where(eq(endpointPools.id, endpoint.poolId)).limit(1),
      this.database.db.select().from(healthCheckConfigs).where(and(eq(healthCheckConfigs.id, job.configId), eq(healthCheckConfigs.enabled, true))).limit(1),
      job.bindingId
        ? this.database.db.select().from(domainBindings).where(and(eq(domainBindings.id, job.bindingId), eq(domainBindings.poolId, endpoint.poolId))).limit(1)
        : Promise.resolve([]),
      job.addressId
        ? this.database.db.select().from(endpointAddresses).where(and(eq(endpointAddresses.id, job.addressId), eq(endpointAddresses.endpointId, endpoint.id))).limit(1)
        : this.database.db.select().from(endpointAddresses).where(and(eq(endpointAddresses.endpointId, endpoint.id), eq(endpointAddresses.state, "current"))).limit(1),
    ]);
    const binding = bindingRows[0];
    const address = addressRows[0];
    if (!pool || !config || !address) return null;
    return { endpoint, pool, config, binding, address };
  }
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

function aggregatePoolState(states: HealthState[]): HealthState {
  if (states.length === 0 || states.every((state) => state === "unknown")) return "unknown";
  const healthy = states.filter((state) => state === "healthy").length;
  if (healthy === states.length) return "healthy";
  if (healthy > 0) return "degraded";
  if (states.some((state) => state === "recovering")) return "recovering";
  if (states.some((state) => state === "degraded")) return "degraded";
  return "unhealthy";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown";
}
