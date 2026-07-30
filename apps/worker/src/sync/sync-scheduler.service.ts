import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { providerAccounts } from "@masterdns/db";
import { inArray } from "drizzle-orm";
import { DatabaseService } from "../database.service.js";
import { env } from "../env.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";

@Injectable()
export class SyncSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private scanning = false;

  constructor(private readonly database: DatabaseService, private readonly queues: QueueRuntimeService) {}

  onModuleInit() {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), env.PROVIDER_SYNC_SCAN_SECONDS * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const accounts = await this.database.db.select({ id: providerAccounts.id }).from(providerAccounts)
        .where(inArray(providerAccounts.status, ["active", "error"]));
      const slot = Math.floor(Date.now() / (env.PROVIDER_SYNC_INTERVAL_SECONDS * 1000));
      await Promise.all(accounts.map(({ id }) => this.queues.sync.add("sync-provider-account", { providerAccountId: id }, {
        jobId: scheduledSyncJobId(id, slot),
        attempts: 3,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: 5_000,
        removeOnFail: 5_000,
      })));
    } catch (error) {
      this.logger.error(`Provider sync schedule scan failed: ${safeError(error)}`);
    } finally {
      this.scanning = false;
    }
  }
}

export function scheduledSyncJobId(accountId: string, slot: number) {
  return `provider-sync-scheduled-${accountId}-${slot}`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown";
}
