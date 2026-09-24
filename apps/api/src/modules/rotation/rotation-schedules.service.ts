import type { RotationSchedule, RotationScheduleResumeInput, RotationScheduleUpdateInput } from "@masterdns/contracts";
import {
  auditLogs,
  cloudAccounts,
  cloudInstances,
  cloudInterfaces,
  healthRevisions,
  lockRotationContext,
  lockRotationHealth,
  lockRotationSchedule,
  managedAddressSlots,
  resumeRotationSchedule,
  rotationAuthorizationError,
  rotationPolicies,
  rotationSchedules,
  scheduledRotationPrerequisiteError,
  updateRotationScheduleConfiguration,
  type PersistedRotationSchedule,
  type RotationContext,
  type RotationTransaction,
} from "@masterdns/db";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { AuthUser } from "../../auth/auth.types.js";
import { DatabaseService } from "../../infrastructure/database.module.js";

@Injectable()
export class RotationSchedulesService {
  constructor(private readonly database: DatabaseService) {}

  async get(actor: AuthUser, slotId: string): Promise<RotationSchedule> {
    const slot = await this.ownedSlot(actor, slotId);
    const [schedule] = await this.database.db.select().from(rotationSchedules).where(eq(rotationSchedules.slotId, slotId));
    return publicSchedule(slotId, schedule, slot.updatedAt);
  }

  async update(actor: AuthUser, slotId: string, input: RotationScheduleUpdateInput): Promise<RotationSchedule> {
    return this.transaction(async tx => {
      const c = await lockRotationContext(tx, slotId);
      this.assertOwned(actor, c);
      const current = await lockRotationSchedule(tx, slotId);
      if ((current?.revision ?? 0) !== input.revision) throw new Error("rotation_schedule_revision_conflict");
      const changed = (current?.enabled ?? false) !== input.enabled
        || (current?.intervalMinutes ?? 1440) !== input.intervalMinutes;
      if (changed && input.enabled) await this.validateEnabled(tx, c, current);

      const result = await updateRotationScheduleConfiguration(tx, slotId, input);
      const schedule = publicSchedule(slotId, result.schedule, c.slot.updatedAt);
      if (result.changed) await tx.insert(auditLogs).values({
        ownerUserId: c.account.ownerUserId,
        actorUserId: actor.id,
        source: "user",
        action: "rotation.schedule.update",
        resourceType: "address_slot",
        resourceId: slotId,
        beforeSnapshot: publicSchedule(slotId, result.before, c.slot.updatedAt),
        afterSnapshot: schedule,
      });
      return schedule;
    });
  }

  async resume(actor: AuthUser, slotId: string, input: RotationScheduleResumeInput): Promise<RotationSchedule> {
    return this.transaction(async tx => {
      const c = await lockRotationContext(tx, slotId);
      this.assertOwned(actor, c);
      const current = await lockRotationSchedule(tx, slotId);
      if (!current) throw new Error("rotation_schedule_not_found");
      if (current.revision !== input.revision) throw new Error("rotation_schedule_revision_conflict");
      if (!current.enabled) throw new Error("rotation_schedule_disabled");
      if (!current.pausedReason) throw new Error("rotation_schedule_not_paused");
      await this.validateEnabled(tx, c, current);

      const result = await resumeRotationSchedule(tx, slotId, input.revision);
      const schedule = publicSchedule(slotId, result.schedule, c.slot.updatedAt);
      await tx.insert(auditLogs).values({
        ownerUserId: c.account.ownerUserId,
        actorUserId: actor.id,
        source: "user",
        action: "rotation.schedule.resume",
        resourceType: "address_slot",
        resourceId: slotId,
        beforeSnapshot: publicSchedule(slotId, result.before, c.slot.updatedAt),
        afterSnapshot: schedule,
      });
      return schedule;
    });
  }

  private async validateEnabled(tx: RotationTransaction, c: RotationContext, schedule: PersistedRotationSchedule | undefined) {
    const authorizationError = rotationAuthorizationError(c, "scheduled");
    if (authorizationError) throw new Error(authorizationError);
    if (!schedule?.activeIncidentId) {
      const prerequisiteError = scheduledRotationPrerequisiteError(c);
      if (prerequisiteError) throw new Error(prerequisiteError);
    }

    const policy = c.policy ?? (await tx.insert(rotationPolicies).values({ slotId: c.slot.id }).returning())[0]!;
    const health = await lockRotationHealth(tx, { ...c, policy });
    healthRevisions(health);
    const requiredWindow = Math.max(health.policy!.successThreshold, health.policy!.failureThreshold)
      * health.policy!.checkIntervalSeconds + health.policy!.executionWindowSeconds;
    if (policy.candidateWindowSeconds < requiredWindow) throw new Error("rotation_candidate_window_too_short");
  }

  private assertOwned(actor: AuthUser, c: RotationContext) {
    if (actor.role !== "admin" && c.account.ownerUserId !== actor.id) throw new NotFoundException("Address slot not found");
  }

  private async ownedSlot(actor: AuthUser, slotId: string) {
    const [row] = await this.database.db.select({ ownerUserId: cloudAccounts.ownerUserId, updatedAt: managedAddressSlots.updatedAt })
      .from(managedAddressSlots)
      .innerJoin(cloudInterfaces, eq(cloudInterfaces.id, managedAddressSlots.interfaceId))
      .innerJoin(cloudInstances, eq(cloudInstances.id, cloudInterfaces.instanceId))
      .innerJoin(cloudAccounts, eq(cloudAccounts.id, cloudInstances.accountId))
      .where(and(eq(managedAddressSlots.id, slotId), actor.role === "admin" ? undefined : eq(cloudAccounts.ownerUserId, actor.id)));
    if (!row) throw new NotFoundException("Address slot not found");
    return row;
  }

  private async transaction<T>(action: (tx: RotationTransaction) => Promise<T>) {
    try {
      return await this.database.db.transaction(action);
    } catch (error) {
      if (error instanceof Error && /^(rotation_|external_health_required|authorization_revoked|family_disabled|region_excluded|resource_not_found|conflicting_manager|instance_lifecycle_busy)/.test(error.message)) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }
}

function publicSchedule(slotId: string, schedule: PersistedRotationSchedule | undefined, fallbackUpdatedAt: Date): RotationSchedule {
  return {
    slotId,
    enabled: schedule?.enabled ?? false,
    intervalMinutes: schedule?.intervalMinutes ?? 1440,
    revision: schedule?.revision ?? 0,
    nextRunAt: schedule?.nextRunAt?.toISOString() ?? null,
    activeIncidentId: schedule?.activeIncidentId ?? null,
    lastStartedAt: schedule?.lastStartedAt?.toISOString() ?? null,
    lastCompletedAt: schedule?.lastCompletedAt?.toISOString() ?? null,
    lastHandledIncidentId: schedule?.lastHandledIncidentId ?? null,
    pausedReason: schedule?.pausedReason ?? null,
    updatedAt: (schedule?.updatedAt ?? fallbackUpdatedAt).toISOString(),
  };
}
