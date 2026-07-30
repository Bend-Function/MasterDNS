import { Controller, Sse, UseGuards, type MessageEvent } from "@nestjs/common";
import { endpointPools, failoverEvents, operations } from "@masterdns/db";
import { desc, eq } from "drizzle-orm";
import { Observable } from "rxjs";
import { CurrentUser } from "../../auth/auth.decorators.js";
import type { AuthUser } from "../../auth/auth.types.js";
import { SseConcurrencyGuard } from "../../auth/sse-concurrency.guard.js";
import { DatabaseService } from "../../infrastructure/database.module.js";

const POLL_INTERVAL_MS = 3_000;

@Controller("v1/events")
export class EventsController {
  constructor(private readonly database: DatabaseService) {}

  @Sse()
  @UseGuards(SseConcurrencyGuard)
  stream(@CurrentUser() actor: AuthUser): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let active = true;
      let polling = false;
      let signature: string | undefined;
      const poll = async () => {
        if (!active || polling) return;
        polling = true;
        try {
          const [latestOperation, latestFailover] = await Promise.all([
            this.database.db.select({ id: operations.id, updatedAt: operations.updatedAt }).from(operations)
              .where(actor.role === "admin" ? undefined : eq(operations.ownerUserId, actor.id))
              .orderBy(desc(operations.updatedAt)).limit(1),
            this.database.db.select({ id: failoverEvents.id, createdAt: failoverEvents.createdAt }).from(failoverEvents)
              .innerJoin(endpointPools, eq(failoverEvents.poolId, endpointPools.id))
              .where(actor.role === "admin" ? undefined : eq(endpointPools.ownerUserId, actor.id))
              .orderBy(desc(failoverEvents.createdAt)).limit(1),
          ]);
          const next = `${latestOperation[0]?.id ?? "-"}:${latestOperation[0]?.updatedAt.toISOString() ?? "-"}:${latestFailover[0]?.id ?? "-"}`;
          if (signature === undefined) {
            signature = next;
            subscriber.next({ type: "ready", data: { connectedAt: new Date().toISOString() } });
          } else if (signature !== next) {
            signature = next;
            subscriber.next({ type: "invalidate", id: next, data: { changedAt: new Date().toISOString() } });
          } else {
            subscriber.next({ type: "heartbeat", data: { time: new Date().toISOString() } });
          }
        } catch {
          subscriber.next({ type: "dependency-error", data: { retrying: true } });
        } finally {
          polling = false;
        }
      };
      void poll();
      const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
      return () => {
        active = false;
        clearInterval(timer);
      };
    });
  }
}
