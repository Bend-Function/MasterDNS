import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, asc, eq, gt, ne, notExists, or, sql } from "drizzle-orm";
import { addressHealthStates, createRotationIncident, lockRotationContext, rotationIncidents, rotationPolicies } from "@masterdns/db";
import { DatabaseService } from "../database.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";
@Injectable()
export class RotationRecoveryService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(RotationRecoveryService.name);
  constructor(private readonly database: DatabaseService, private readonly queues: QueueRuntimeService) {}
  onModuleInit() { void this.tick(); this.timer = setInterval(() => void this.tick(), 5000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async recover() {
    // Redis is only a wake-up channel. DB evidence and incident deadlines are the
    // source of truth across lost jobs, retries and process restarts.
    // Apply the admission budget after authorization checks. Keyset pages let
    // rejected prefixes yield to eligible failures beyond the first page.
    let afterSlotId: string | undefined;
    let admitted = 0;
    while (admitted < 200) {
      const failures = await this.database.db.select({ slotId: rotationPolicies.slotId, lastRoundId: addressHealthStates.lastRoundId, addressVersion: addressHealthStates.addressVersion }).from(rotationPolicies)
        .innerJoin(addressHealthStates, eq(addressHealthStates.slotId, rotationPolicies.slotId)).where(and(
          afterSlotId ? gt(rotationPolicies.slotId, afterSlotId) : undefined,
          eq(rotationPolicies.enabled, true), eq(addressHealthStates.latestDecision, "failure"), eq(addressHealthStates.healthState, "unhealthy"), sql`${addressHealthStates.evidenceExpiresAt} > clock_timestamp()`,
          notExists(this.database.db.select({ id: rotationIncidents.id }).from(rotationIncidents).where(and(eq(rotationIncidents.slotId, rotationPolicies.slotId), or(ne(rotationIncidents.status, "complete"), eq(rotationIncidents.sourceEventId, sql`'health-' || ${addressHealthStates.lastRoundId} || '-' || ${addressHealthStates.addressVersion}`)))))
        )).orderBy(asc(rotationPolicies.slotId)).limit(200);
      if (!failures.length) break;
      for (const failure of failures) {
        afterSlotId = failure.slotId;
        try {
          await this.database.db.transaction(async tx => {
            const c = await lockRotationContext(tx, failure.slotId);
            await createRotationIncident(tx, c, `health-${failure.lastRoundId}-${failure.addressVersion}`);
          });
          admitted++;
        } catch (error) {
          if (!(error instanceof Error && ["confirmed_failure_required", "authorization_revoked", "family_disabled", "region_excluded", "resource_not_found", "conflicting_manager", "external_health_required", "instance_lifecycle_busy"].includes(error.message))) throw error;
        }
        if (admitted === 200) break;
      }
      if (failures.length < 200) break;
    }
    const due = await this.database.db.select({ id: rotationIncidents.id }).from(rotationIncidents).where(and(ne(rotationIncidents.status, "complete"), sql`${rotationIncidents.nextRunAt} <= clock_timestamp()`)).orderBy(asc(rotationIncidents.nextRunAt)).limit(200);
    await Promise.all(due.map(row => this.queues.rotation.add("rotate", { incidentId: row.id }, { jobId: `rotation-${row.id}`, removeOnComplete: true, removeOnFail: true })));
    return due.length;
  }
  private async tick() {
    if (this.running) return; this.running = true;
    try { await this.recover(); } catch (error) { this.logger.error(error instanceof Error ? error.message : "Rotation recovery failed"); } finally { this.running = false; }
  }
}
