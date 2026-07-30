import { randomUUID } from "node:crypto";
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { endpointPools, failoverEvents } from "@masterdns/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { DatabaseService } from "../database.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";

const SCAN_INTERVAL_MS = 60_000;
const REMINDER_EVENT_TYPES = ["pool.no_healthy_endpoint", "pool.no_healthy_endpoint_reminder"];

@Injectable()
export class AllDownReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AllDownReminderService.name);
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
      const pools = await this.database.db.select().from(endpointPools).where(and(
        eq(endpointPools.enabled, true),
        eq(endpointPools.state, "unhealthy"),
      ));
      for (const pool of pools) await this.remindIfDue(pool);
    } catch (error) {
      this.logger.error(`All-down reminder scan failed: ${safeError(error)}`);
    } finally {
      this.scanning = false;
    }
  }

  private async remindIfDue(pool: typeof endpointPools.$inferSelect) {
    const now = new Date();
    const event = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`all-down-reminder:${pool.id}`}))`);
      const [latest] = await tx.select().from(failoverEvents).where(and(
        eq(failoverEvents.poolId, pool.id),
        inArray(failoverEvents.eventType, REMINDER_EVENT_TYPES),
      )).orderBy(desc(failoverEvents.createdAt)).limit(1);
      if (!latest || !isReminderDue(latest.createdAt, pool.allDownReminderSeconds, now)) return null;
      const eventId = randomUUID();
      await tx.insert(failoverEvents).values({
        poolId: pool.id,
        eventType: "pool.no_healthy_endpoint_reminder",
        evidence: { eventId, previousEventId: latest.id, reminderSeconds: pool.allDownReminderSeconds },
        decision: { action: "preserve_current_dns" },
      });
      return {
        eventId,
        eventType: "pool.no_healthy_endpoint_reminder",
        ownerUserId: pool.ownerUserId,
        poolId: pool.id,
        occurredAt: now.toISOString(),
        payload: { summary: `Pool ${pool.name} still has no healthy endpoints; current DNS records remain preserved.`, poolName: pool.name },
      };
    });
    if (!event) return;
    await this.queues.notifications.add("fanout-event", { kind: "fanout", event }, {
      jobId: `fanout-${event.eventId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 5_000,
      removeOnFail: 5_000,
    });
  }
}

export function isReminderDue(previous: Date, intervalSeconds: number, now = new Date()): boolean {
  return now.getTime() - previous.getTime() >= intervalSeconds * 1000;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown";
}
