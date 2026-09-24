import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { asc, eq, gt } from "drizzle-orm";
import { createScheduledRotationIncident, databaseNow, lockRotationContext, reconcileRotationSchedule, rotationSchedules } from "@masterdns/db";
import { DatabaseService } from "../database.service.js";
import { QueueRuntimeService } from "../queue-runtime.service.js";

const benignAdmissionErrors = new Set([
  "rotation_schedule_not_found", "rotation_schedule_disabled", "rotation_schedule_paused", "rotation_schedule_active", "rotation_schedule_not_due", "rotation_active_conflict",
]);
const prerequisiteErrors = new Set([
  "rotation_candidate_exists", "rotation_public_ipv4_required", "rotation_private_ipv4_unsupported", "rotation_provider_service_unsupported", "rotation_policy_missing",
  "authorization_revoked", "family_disabled", "region_excluded", "resource_not_found", "conflicting_manager", "external_health_required", "instance_lifecycle_busy",
]);

@Injectable()
export class RotationSchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(RotationSchedulerService.name);
  constructor(private readonly database: DatabaseService, private readonly queues: QueueRuntimeService) {}
  onModuleInit() { void this.tick(); this.timer = setInterval(() => void this.tick(), 10_000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async scan() {
    let afterSlotId: string | undefined;
    let admitted = 0;
    // Traverse every key, including disabled schedules with an accepted incident.
    // A blocked/invalid prefix must never prevent later pages being reconciled.
    while (true) {
      const page = await this.database.db.select({ slotId: rotationSchedules.slotId }).from(rotationSchedules)
        .where(afterSlotId ? gt(rotationSchedules.slotId, afterSlotId) : undefined)
        .orderBy(asc(rotationSchedules.slotId)).limit(200);
      for (const row of page) {
        afterSlotId = row.slotId;
        try {
          const incident = await this.database.db.transaction(async tx => {
            const c = await lockRotationContext(tx, row.slotId);
            const schedule = await reconcileRotationSchedule(tx, row.slotId);
            if (!schedule || !schedule.enabled || schedule.pausedReason || schedule.activeIncidentId || !schedule.nextRunAt) return;
            const now = await databaseNow(tx);
            if (schedule.nextRunAt > now) return;
            try {
              // Admission owns the authoritative DB-clock due/revision check and
              // atomic event, budget and schedule association; never call cloud APIs.
              return await createScheduledRotationIncident(tx, c);
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              if (benignAdmissionErrors.has(error.message)) return;
              if (!prerequisiteErrors.has(error.message)) throw error;
              await tx.update(rotationSchedules).set({ pausedReason: error.message, nextRunAt: null, updatedAt: now }).where(eq(rotationSchedules.slotId, row.slotId));
            }
          });
          if (incident) {
            admitted++;
            // Commit precedes wake-up. Recovery re-enqueues durable due incidents
            // if Redis is unavailable or this process exits before queue.add.
            await this.queues.rotation.add("rotate", { incidentId: incident.id }, { jobId: `rotation-${incident.id}`, removeOnComplete: true, removeOnFail: true });
          }
        } catch (error) {
          this.logger.error(`Schedule ${row.slotId}: ${error instanceof Error ? error.message : "scan failed"}`);
        }
      }
      if (page.length < 200) return admitted;
    }
  }
  private async tick() {
    if (this.running) return;
    this.running = true;
    try { await this.scan(); }
    catch (error) { this.logger.error(error instanceof Error ? error.message : "Rotation scheduling failed"); }
    finally { this.running = false; }
  }
}
