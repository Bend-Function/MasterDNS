import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { HealthCheckJob } from "@masterdns/contracts";
import { domainBindings, endpointAddresses, endpointPools, endpoints, healthCheckConfigs } from "@masterdns/db";
import { and, eq } from "drizzle-orm";
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
          addressId: endpointAddresses.id,
          family: endpointAddresses.family,
        }).from(endpointAddresses)
          .innerJoin(endpoints, eq(endpointAddresses.endpointId, endpoints.id))
          .innerJoin(endpointPools, eq(endpoints.poolId, endpointPools.id))
          .where(and(eq(endpoints.lifecycle, "enabled"), eq(endpointAddresses.state, "current"))),
        this.database.db.select().from(healthCheckConfigs).where(eq(healthCheckConfigs.enabled, true)),
        this.database.db.select({ id: domainBindings.id, poolId: domainBindings.poolId, recordType: domainBindings.recordType }).from(domainBindings),
      ]);

      const now = Date.now();
      await Promise.all(buildScheduledHealthJobs(targets, configs, bindings)
        .map((scheduled) => this.enqueue(scheduled.data, scheduled.intervalSeconds, now)));
    } catch (error) {
      this.logger.error(`Health schedule scan failed: ${safeError(error)}`);
    } finally {
      this.scanning = false;
    }
  }

  private async enqueue(data: HealthCheckJob, intervalSeconds: number, now: number) {
    const intervalMs = Math.max(5, intervalSeconds) * 1000;
    const slot = Math.floor(now / intervalMs);
    const scope = `${data.bindingId ?? "base"}-${data.addressId ?? "address"}`;
    await this.queues.health.add("check-endpoint", data, {
      jobId: `health-${data.endpointId}-${data.configId}-${scope}-${slot}`,
      attempts: 1,
      removeOnComplete: 5_000,
      removeOnFail: 5_000,
    });
  }
}

type ScheduledTarget = {
  endpointId: string;
  poolId: string;
  intervalSeconds: number;
  addressId: string;
  family: "4" | "6";
};

type ScheduledConfig = {
  id: string;
  poolId: string | null;
  endpointId: string | null;
  domainBindingId: string | null;
};

type ScheduledBinding = {
  id: string;
  poolId: string;
  recordType: string;
};

export function buildScheduledHealthJobs(
  targets: ScheduledTarget[],
  configs: ScheduledConfig[],
  bindings: ScheduledBinding[],
): Array<{ data: HealthCheckJob; intervalSeconds: number }> {
  const bindingsByPool = groupBy(bindings, (binding) => binding.poolId);
  const poolConfigs = groupBy(configs.filter((config) => config.poolId), (config) => config.poolId!);
  const endpointConfigs = groupBy(configs.filter((config) => config.endpointId), (config) => config.endpointId!);
  const bindingConfigs = groupBy(configs.filter((config) => config.domainBindingId), (config) => config.domainBindingId!);
  const scheduled: Array<{ data: HealthCheckJob; intervalSeconds: number }> = [];

  for (const target of targets) {
    const base = endpointConfigs.get(target.endpointId) ?? poolConfigs.get(target.poolId) ?? [];
    for (const config of base) scheduled.push({
      data: { endpointId: target.endpointId, configId: config.id, addressId: target.addressId },
      intervalSeconds: target.intervalSeconds,
    });
    for (const binding of bindingsByPool.get(target.poolId) ?? []) {
      if ((binding.recordType === "AAAA" ? "6" : "4") !== target.family) continue;
      for (const config of bindingConfigs.get(binding.id) ?? []) scheduled.push({
        data: { endpointId: target.endpointId, configId: config.id, bindingId: binding.id, addressId: target.addressId },
        intervalSeconds: target.intervalSeconds,
      });
    }
  }
  return scheduled;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const output = new Map<string, T[]>();
  for (const item of items) output.set(key(item), [...(output.get(key(item)) ?? []), item]);
  return output;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown";
}
