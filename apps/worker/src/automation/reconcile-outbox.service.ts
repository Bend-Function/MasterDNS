import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { PoolReconcileJob } from "@masterdns/contracts";
import { reconcileIntents } from "@masterdns/db";
import { and, asc, isNull, lte } from "drizzle-orm";
import { DatabaseService } from "../database.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";

const SCAN_INTERVAL_MS = 1_000;

@Injectable()
export class ReconcileOutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcileOutboxService.name);
  private timer?: NodeJS.Timeout;
  private dispatching = false;

  constructor(private readonly database: DatabaseService, private readonly queues: QueueRuntimeService) {}

  async onModuleInit() {
    await this.dispatchPending();
    this.timer = setInterval(() => void this.dispatchPending(), SCAN_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async dispatchPending() {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const now = new Date();
      const intents = await this.database.db.select().from(reconcileIntents).where(and(
        isNull(reconcileIntents.completedAt),
        lte(reconcileIntents.availableAt, now),
      )).orderBy(asc(reconcileIntents.availableAt)).limit(100);
      await Promise.all(intents.map((intent) => {
        const data: PoolReconcileJob = {
          poolId: intent.poolId,
          eventId: intent.eventId,
          decisionRevision: intent.decisionRevision,
          policyRevision: intent.policyRevision,
          trigger: intent.trigger,
          source: intent.source,
          ...(intent.endpointId ? { endpointId: intent.endpointId } : {}),
          ...(intent.force ? { force: true } : {}),
        };
        return this.queues.reconcile.add("reconcile-pool", data, {
          jobId: `reconcile-intent-${intent.eventId}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 1_000 },
          removeOnComplete: 5_000,
          removeOnFail: true,
        });
      }));
    } catch (error) {
      this.logger.error(`Reconcile outbox scan failed: ${safeError(error)}`);
    } finally {
      this.dispatching = false;
    }
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown";
}
