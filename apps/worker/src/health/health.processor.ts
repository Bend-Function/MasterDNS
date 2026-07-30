import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { applyHealthResult } from "@masterdns/automation";
import { CheckerRegistry } from "@masterdns/checkers";
import type { HealthCheckConfig, HealthCheckJob, HealthState, PoolReconcileJob } from "@masterdns/contracts";
import { healthCheckConfigSchema, queueNames } from "@masterdns/contracts";
import {
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
      const next = applyHealthResult({
        state: current.healthState,
        consecutiveSuccesses: current.consecutiveSuccesses,
        consecutiveFailures: current.consecutiveFailures,
      }, result.success, {
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
      await tx.update(endpoints).set({
        healthState: next.state,
        consecutiveSuccesses: next.consecutiveSuccesses,
        consecutiveFailures: next.consecutiveFailures,
        lastCheckedAt: result.checkedAt,
        ...(next.state !== current.healthState ? { stateChangedAt: result.checkedAt } : {}),
        updatedAt: new Date(),
      }).where(eq(endpoints.id, current.id));

      let promoted = false;
      if (target.address.state === "candidate" && next.state === "healthy") {
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
        promoted = true;
      }

      const poolEndpoints = await tx.select({ state: endpoints.healthState }).from(endpoints)
        .where(eq(endpoints.poolId, target.pool.id));
      await tx.update(endpointPools).set({ state: aggregatePoolState(poolEndpoints.map((item) => item.state)), updatedAt: new Date() })
        .where(eq(endpointPools.id, target.pool.id));

      if (promoted) return { trigger: "configuration" as const, previous: current.healthState, next: next.state };
      if (next.state === current.healthState) return null;
      if (next.state === "unhealthy") return { trigger: "failure" as const, previous: current.healthState, next: next.state };
      if (next.state === "healthy" && current.healthState !== "healthy") return { trigger: "recovery" as const, previous: current.healthState, next: next.state };
      return null;
    });

    if (transition) {
      const eventId = randomUUID();
      const data: PoolReconcileJob = {
        poolId: target.pool.id,
        eventId,
        trigger: transition.trigger,
        endpointId: target.endpoint.id,
      };
      const delay = transition.trigger === "recovery" && target.pool.recoveryMode === "delayed"
        ? target.pool.recoveryDelaySeconds * 1000
        : 0;
      await this.queues.reconcile.add("reconcile-pool", data, {
        jobId: `reconcile-${eventId}`,
        delay,
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: 5_000,
        removeOnFail: 5_000,
      });
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
