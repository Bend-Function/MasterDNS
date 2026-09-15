import { HealthResultService } from "./health-result.service.js";
export { aggregatePoolState, isAddressStillIntended, isBindingHealthForAddress, isHealthCheckDefinitionCurrent, recoveryReconcileDelayMs } from "./health-result.service.js";
import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { CheckerRegistry } from "@masterdns/checkers";
import type { HealthCheckJob } from "@masterdns/contracts";
import { healthCheckConfigSchema, queueNames } from "@masterdns/contracts";
import { addressHealthPolicies, domainBindings, endpointAddresses, endpointPools, endpoints, healthCheckConfigs } from "@masterdns/db";
import { and, eq } from "drizzle-orm";
import { Job, Worker } from "bullmq";
import { DatabaseService } from "../database.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";

@Injectable()
export class HealthProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthProcessor.name);
  private readonly registry = new CheckerRegistry(undefined, { allowPrivate: process.env.ALLOW_PRIVATE_HEALTH_TARGETS === "true" });
  private worker?: Worker<HealthCheckJob>;

  constructor(private readonly database: DatabaseService, private readonly queues: QueueRuntimeService, private readonly results: HealthResultService) {}

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

    await this.results.applyObserved(target, result);
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
    if (!binding) {
      if (endpoint.addressMode === "cloud") return null;
      const [policy] = await this.database.db.select().from(addressHealthPolicies).where(and(eq(addressHealthPolicies.endpointId, endpoint.id), eq(addressHealthPolicies.family, address.family)));
      if (policy && policy.mode !== "local") return null;
    }
    return { endpoint, pool, config, binding, address };
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown";
}
