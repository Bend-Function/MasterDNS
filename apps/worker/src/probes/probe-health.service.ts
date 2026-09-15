import { Injectable, Logger } from "@nestjs/common";
import { advanceRoundHealth, evaluateProbeRound } from "@masterdns/automation";
import { CheckerRegistry } from "@masterdns/checkers";
import { isAllowedProbeTarget, type ProbeOutcome } from "@masterdns/contracts";
import { addressHealthPolicies, addressHealthStates, healthCheckConfigs, healthTargetWhere, lockHealthTarget, probeAgents, probeGroups, probeObservations, probeRounds } from "@masterdns/db";
import { and, asc, eq, gt, isNull, notInArray, sql } from "drizzle-orm";
import { DatabaseService } from "../database.service.js";
import { HealthResultService } from "../health/health-result.service.js";
@Injectable()
export class ProbeHealthService {
  private readonly logger = new Logger(ProbeHealthService.name);
  private readonly localChecks = new Set<string>();
  private admittingLocal = false;
  constructor(private readonly database: DatabaseService, private readonly results: HealthResultService) {}
  async closeRound(roundId: string, now = new Date()) {
    return this.database.db.transaction(async tx => {
      const [snapshot] = await tx.select().from(probeRounds).where(eq(probeRounds.id, roundId));
      if (!snapshot || snapshot.status !== "pending" || snapshot.deadline > now) return undefined;
      const target = await lockHealthTarget(tx, snapshot);
      const [config] = await tx.select().from(healthCheckConfigs).where(eq(healthCheckConfigs.id, snapshot.configId)).for("share");
      const [group] = snapshot.groupId ? await tx.select().from(probeGroups).where(eq(probeGroups.id, snapshot.groupId)).for("share") : [];
      const [policy] = snapshot.policyId ? await tx.select().from(addressHealthPolicies).where(eq(addressHealthPolicies.id, snapshot.policyId)).for("share") : [];
      const [state] = await tx.select().from(addressHealthStates).where(healthTargetWhere(addressHealthStates, snapshot));
      const [round] = await tx.select().from(probeRounds).where(eq(probeRounds.id, roundId)).for("update");
      if (!round || round.status !== "pending") return undefined;
      const fresh = !!target && !!state && !!policy && !!config?.enabled 
        && config.revision === round.configVersion && policy.id === state.policyId && policy.revision === round.policyRevision
        && policy.configId === config.id && (policy.mode === "local" ? round.groupId === null : policy.groupId === round.groupId) && (round.groupId ? group?.revision === round.groupRevision : policy.mode === "local" && round.groupRevision === null)
        && target.addressVersion === round.addressVersion && target.addressId === state.addressId && target.address === round.address
        && state.configVersion === round.configVersion && state.policyRevision === policy.revision && state.groupRevision === (group?.revision ?? null)
        && state.lastAppliedSequence < round.sequence;
      if (!fresh) {
        await tx.update(probeRounds).set({ status: "superseded", consensusResult: "unknown", finalizedAt: now }).where(eq(probeRounds.id, round.id));
        return "unknown" as const;
      }
      const observations = await tx.select({ observation: probeObservations, agent: probeAgents }).from(probeObservations).innerJoin(probeAgents, eq(probeObservations.probeId, probeAgents.id)).where(and(eq(probeObservations.roundId, round.id), eq(probeObservations.status, "accepted")));
      const outcomes: Record<string, ProbeOutcome> = {};
      for (const { observation, agent } of observations) {
        if (agent.enabled && !agent.revokedAt && (round.family === "4" ? agent.capabilities.ipv4 : agent.capabilities.ipv6)
          && observation.addressVersion === round.addressVersion && observation.configVersion === round.configVersion && observation.receivedAt < round.deadline) outcomes[observation.probeId] = observation.outcome;
      }
      if (round.memberIds.includes("local") && round.localOutcome && round.localReceivedAt && round.localReceivedAt < round.deadline) outcomes.local = round.localOutcome;
      const externalVotes = round.memberIds.filter(id => id !== "local" && (outcomes[id] === "success" || outcomes[id] === "failure")).length;
      const localOnlyAuthority = !!round.slotId && policy.mode === "mixed" && (externalVotes === 0 || (round.consensus.mode === "specified" && round.consensus.specifiedProbeId === "local"));
      const decision = round.resultExpiresAt <= now || localOnlyAuthority ? "unknown" : evaluateProbeRound({ memberIds: round.memberIds, outcomes, policy: round.consensus });
      const next = advanceRoundHealth({ state: state.healthState, consecutiveSuccesses: state.consecutiveSuccesses, consecutiveFailures: state.consecutiveFailures }, round.id, decision, policy);
      await tx.update(addressHealthStates).set({ healthState: next.state, consecutiveSuccesses: next.consecutiveSuccesses, consecutiveFailures: next.consecutiveFailures, lastAppliedSequence: round.sequence, lastRoundId: round.id, latestDecision: decision, evidenceExpiresAt: decision === "unknown" ? null : round.resultExpiresAt, lastCheckedAt: now, ...(next.state !== state.healthState || decision !== state.latestDecision ? { stateChangedAt: now } : {}), updatedAt: now }).where(eq(addressHealthStates.id, state.id));
      if (target.endpoint && target.pool && target.endpointAddress) {
        await this.results.applyObserved({ endpoint: target.endpoint, pool: target.pool, address: target.endpointAddress, config }, { success: decision === "success", latencyMs: 0, checkedAt: now }, tx, { next, decision, roundId: round.id, successThreshold: policy.successThreshold });
      }
      await tx.update(probeRounds).set({ status: "completed", consensusResult: decision, finalizedAt: now, appliedAt: now }).where(eq(probeRounds.id, round.id));
      return decision;
    });
  }
  async recordLocal(roundId: string, outcome: ProbeOutcome, now = new Date()) {
    // No target/task locks: a local result is only one observation; finalization owns health.
    const rows = await this.database.db.update(probeRounds).set({ localOutcome: outcome, localReceivedAt: now }).where(and(eq(probeRounds.id, roundId), eq(probeRounds.status, "pending"), isNull(probeRounds.localReceivedAt), gt(probeRounds.deadline, now), sql`${probeRounds.memberIds} @> '["local"]'::jsonb`)).returning();
    return rows.length > 0;
  }
  async checkPendingLocal(now = new Date()) {
    const capacity = 20 - this.localChecks.size;
    if (this.admittingLocal || capacity <= 0) return;
    this.admittingLocal = true;
    try {
      const pending = await this.database.db.select({ id: probeRounds.id }).from(probeRounds).where(and(
        eq(probeRounds.status, "pending"), isNull(probeRounds.localReceivedAt), gt(probeRounds.deadline, now),
        sql`${probeRounds.memberIds} @> '["local"]'::jsonb`,
        this.localChecks.size ? notInArray(probeRounds.id, [...this.localChecks]) : undefined,
      )).orderBy(asc(probeRounds.deadline), asc(probeRounds.id)).limit(capacity);
      for (const round of pending) void this.checkLocal(round.id).catch(error => this.logger.warn(String(error)));
    } finally { this.admittingLocal = false; }
  }
  async checkLocal(roundId: string) {
    if (this.localChecks.size >= 20 || this.localChecks.has(roundId)) return;
    this.localChecks.add(roundId);
    try {
      const [round] = await this.database.db.select().from(probeRounds).where(eq(probeRounds.id, roundId));
      if (!round?.memberIds.includes("local") || round.status !== "pending" || round.localReceivedAt || round.deadline <= new Date()) return;
      const family = Number(round.family) as 4 | 6;
      const privateOptIn = process.env.ALLOW_PRIVATE_HEALTH_TARGETS === "true";
      if (!isAllowedProbeTarget(round.address, family, privateOptIn ? round.networkPolicy ?? undefined : undefined)) {
        await this.recordLocal(round.id, "unavailable");
        return;
      }
      const registry = new CheckerRegistry(undefined, { allowPrivate: privateOptIn });
      const config = round.config;
      const port = config.type === "tcp" ? config.port : config.port ?? (config.protocol === "https" ? 443 : 80);
      const remaining = round.deadline.getTime() - Date.now();
      if (remaining <= 0) return;
      try {
        const result = await registry.get(config.type).check({ address: round.address, family, port, hostname: config.type === "http" ? config.hostname ?? round.hostname ?? undefined : undefined }, config as never, AbortSignal.timeout(remaining));
        const unavailable = ["target_not_allowed", "invalid_target", "eafnosupport", "eaddrnotavail", "enetunreach", "abort_err"].includes(result.errorCode ?? "");
        await this.recordLocal(round.id, unavailable ? "unavailable" : result.success ? "success" : "failure");
      } catch { await this.recordLocal(round.id, "unavailable"); }
    } finally { this.localChecks.delete(roundId); }
  }
}
