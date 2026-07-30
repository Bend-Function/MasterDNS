import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { HealthCheckJob } from "@masterdns/contracts";
import { domainBindings, endpointPools, endpoints, healthCheckConfigs } from "@masterdns/db";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../database.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";

const SCAN_INTERVAL_MS = 5_000;

@Injectable()
export class HealthSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private scanning = false;

  constructor(private readonly database: DatabaseService, private readonly queues: QueueRuntimeService) {}

  onModuleInit() {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const [targets, configs, bindings] = await Promise.all([
        this.database.db.select({
          endpointId: endpoints.id,
          poolId: endpoints.poolId,
          intervalSeconds: endpointPools.checkIntervalSeconds,
        }).from(endpoints)
          .innerJoin(endpointPools, eq(endpoints.poolId, endpointPools.id))
          .where(eq(endpoints.lifecycle, "enabled")),
        this.database.db.select().from(healthCheckConfigs).where(eq(healthCheckConfigs.enabled, true)),
        this.database.db.select({ id: domainBindings.id, poolId: domainBindings.poolId }).from(domainBindings),
      ]);

      const bindingsByPool = groupBy(bindings, (binding) => binding.poolId);
      const poolConfigs = groupBy(configs.filter((config) => config.poolId), (config) => config.poolId!);
      const endpointConfigs = groupBy(configs.filter((config) => config.endpointId), (config) => config.endpointId!);
      const bindingConfigs = groupBy(configs.filter((config) => config.domainBindingId), (config) => config.domainBindingId!);
      const now = Date.now();
      const enqueue: Promise<unknown>[] = [];

      for (const target of targets) {
        const base = endpointConfigs.get(target.endpointId) ?? poolConfigs.get(target.poolId) ?? [];
        for (const config of base) enqueue.push(this.enqueue(target.endpointId, config.id, target.intervalSeconds, now));
        for (const binding of bindingsByPool.get(target.poolId) ?? []) {
          for (const config of bindingConfigs.get(binding.id) ?? []) {
            enqueue.push(this.enqueue(target.endpointId, config.id, target.intervalSeconds, now, binding.id));
          }
        }
      }
      await Promise.all(enqueue);
    } catch (error) {
      this.logger.error(`Health schedule scan failed: ${safeError(error)}`);
    } finally {
      this.scanning = false;
    }
  }

  private async enqueue(endpointId: string, configId: string, intervalSeconds: number, now: number, bindingId?: string) {
    const intervalMs = Math.max(5, intervalSeconds) * 1000;
    const slot = Math.floor(now / intervalMs);
    const data: HealthCheckJob = { endpointId, configId, ...(bindingId ? { bindingId } : {}) };
    const scope = bindingId ?? "base";
    await this.queues.health.add("check-endpoint", data, {
      jobId: `health-${endpointId}-${configId}-${scope}-${slot}`,
      attempts: 1,
      removeOnComplete: 5_000,
      removeOnFail: 5_000,
    });
  }
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const output = new Map<string, T[]>();
  for (const item of items) output.set(key(item), [...(output.get(key(item)) ?? []), item]);
  return output;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown";
}
