import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq, lte } from "drizzle-orm";
import { addressHealthPolicies, addressHealthStates, createProbeRound, healthCheckConfigs, healthTargetWhere, lockHealthTarget, probeGroups, probeRounds, resetHealthEvidence } from "@masterdns/db";
import { DatabaseService } from "../database.service.js";
import { ProbeHealthService } from "./probe-health.service.js";
@Injectable()
export class ProbeSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProbeSchedulerService.name);
  private timer?: NodeJS.Timeout;
  private scanning = false;
  constructor(private readonly database: DatabaseService, private readonly health: ProbeHealthService) {}
  onModuleInit() { void this.scan(); this.timer = setInterval(() => void this.scan(), 1000); this.timer.unref(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async scan(now = new Date()) {
    if (this.scanning) return; this.scanning = true;
    try {
      const pending = await this.database.db.select().from(probeRounds).where(and(eq(probeRounds.status, "pending"), lte(probeRounds.deadline, now)));
      for (const round of pending) await this.health.closeRound(round.id, now);
      const policies = await this.database.db.select().from(addressHealthPolicies);
      for (const policy of policies) {
        try { const round = await this.schedulePolicy(policy.id, now); if (round?.memberIds.includes("local")) void this.health.checkLocal(round.id).catch(error => this.logger.warn(String(error))); }
        catch (error) { this.logger.warn(`Probe policy ${policy.id}: ${String(error)}`); }
      }
    } catch (error) { this.logger.error(String(error)); }
    finally { this.scanning = false; }
  }
  async schedulePolicy(policyId: string, now = new Date()) {
    return this.database.db.transaction(async tx => {
      const [snapshot] = await tx.select().from(addressHealthPolicies).where(eq(addressHealthPolicies.id, policyId));
      if (!snapshot || (snapshot.mode === "local" && !snapshot.slotId)) return undefined;
      const target = await lockHealthTarget(tx, snapshot, true, now);
      if (!target || target.addressVersion < 1) return undefined;
      const [config] = await tx.select().from(healthCheckConfigs).where(eq(healthCheckConfigs.id, snapshot.configId)).for("share");
      const [group] = snapshot.groupId ? await tx.select().from(probeGroups).where(eq(probeGroups.id, snapshot.groupId)).for("share") : [];
      const [policy] = await tx.select().from(addressHealthPolicies).where(eq(addressHealthPolicies.id, policyId)).for("share");
      if (!policy || policy.revision !== snapshot.revision || !config?.enabled || (!group && policy.mode !== "local")) return undefined;
      let [state] = await tx.select().from(addressHealthStates).where(healthTargetWhere(addressHealthStates, snapshot));
      const epoch = { addressId: target.addressId, addressVersion: target.addressVersion, configId: config.id, configVersion: config.revision, policyId: policy.id, policyRevision: policy.revision, groupRevision: group?.revision ?? null };
      const changed = !state || Object.entries(epoch).some(([key, value]) => state![key as keyof typeof state] !== value);
      if (!changed && state?.nextRoundAt && state.nextRoundAt > now) return undefined;
      if (state && !changed && state.evidenceExpiresAt && state.evidenceExpiresAt <= now) {
        [state] = await tx.update(addressHealthStates).set({ consecutiveSuccesses: 0, consecutiveFailures: 0, latestDecision: "unknown", evidenceExpiresAt: null, updatedAt: now }).where(eq(addressHealthStates.id, state.id)).returning();
      }
      if (state && changed) {
        [state] = await tx.update(addressHealthStates).set({ ...resetHealthEvidence, ...epoch, stateChangedAt: now, updatedAt: now }).where(eq(addressHealthStates.id, state.id)).returning();
      } else if (!state) {
        [state] = await tx.insert(addressHealthStates).values({ slotId: snapshot.slotId, endpointId: snapshot.endpointId, family: snapshot.family, ...epoch, stateChangedAt: now }).returning();
      }
      const round = await createProbeRound(tx, { id: "worker", role: "admin" }, { slotId: snapshot.slotId ?? undefined, endpointAddressId: snapshot.endpointId ? target.addressId : undefined, configId: config.id, groupId: group?.id, addressVersion: target.addressVersion, consensus: policy.consensus, deadline: new Date(now.getTime()+policy.executionWindowSeconds*1000), resultExpiresAt: new Date(now.getTime()+policy.resultExpirySeconds*1000), networkPolicy: policy.networkPolicy ?? undefined, includeLocal: policy.mode !== "external", dispatchCapableOnly: true, policyId: policy.id, policyRevision: policy.revision }, now);
      await tx.update(addressHealthStates).set({ nextRoundAt: new Date(now.getTime()+policy.checkIntervalSeconds*1000), updatedAt: now }).where(eq(addressHealthStates.id, state!.id));
      return round;
    });
  }
}
