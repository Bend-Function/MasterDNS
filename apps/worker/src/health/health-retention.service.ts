import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DatabaseService } from "../database.service.js";
import { env } from "../env.js";

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class HealthRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthRetentionService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly database: DatabaseService) {}

  onModuleInit() {
    void this.run();
    this.timer = setInterval(() => void this.run(), MAINTENANCE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      await this.aggregate("hour");
      await this.aggregate("day");
      await this.database.db.execute(sql`
        delete from health_check_results
        where checked_at < now() - (${env.HEALTH_RAW_RETENTION_DAYS} * interval '1 day')
      `);
      await this.database.db.execute(sql`
        delete from health_check_stats
        where bucket_start < now() - (${env.HEALTH_STATS_RETENTION_DAYS} * interval '1 day')
      `);
    } catch (error) {
      this.logger.error(`Health retention maintenance failed: ${safeError(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async aggregate(period: "hour" | "day") {
    const periodSql = sql.raw(period === "hour" ? "'hour'" : "'day'");
    await this.database.db.execute(sql`
      insert into health_check_stats (
        id, endpoint_id, domain_binding_id, scope_key, period, bucket_start,
        sample_count, success_count, average_latency_ms, minimum_latency_ms, maximum_latency_ms
      )
      select
        gen_random_uuid(),
        endpoint_id,
        domain_binding_id,
        coalesce(domain_binding_id::text, 'base'),
        ${periodSql}::health_stat_period,
        date_trunc(${periodSql}, checked_at),
        count(*)::integer,
        count(*) filter (where success)::integer,
        avg(latency_ms)::real,
        min(latency_ms)::real,
        max(latency_ms)::real
      from health_check_results
      where checked_at >= now() - (${env.HEALTH_RAW_RETENTION_DAYS} * interval '1 day')
        and checked_at < date_trunc(${periodSql}, now())
      group by endpoint_id, domain_binding_id, coalesce(domain_binding_id::text, 'base'), date_trunc(${periodSql}, checked_at)
      on conflict (endpoint_id, scope_key, period, bucket_start) do update set
        domain_binding_id = excluded.domain_binding_id,
        sample_count = excluded.sample_count,
        success_count = excluded.success_count,
        average_latency_ms = excluded.average_latency_ms,
        minimum_latency_ms = excluded.minimum_latency_ms,
        maximum_latency_ms = excluded.maximum_latency_ms,
        updated_at = now()
    `);
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown";
}
