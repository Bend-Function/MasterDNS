import { isDeepStrictEqual } from "node:util";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { externalHealthCheckConfigSchema, healthCheckConfigSchema } from "@masterdns/contracts";
import { addressHealthPolicies, addressHealthStates, auditLogs, cloudAccounts, cloudInstances, cloudInterfaces, endpointPools, endpoints, healthCheckConfigs, healthTargetWhere, managedAddressSlots, probeAgents, probeGroupMembers, probeGroups, probeObservations, probeObservationStats, probeRounds, resetHealthEvidence, type HealthTargetIdentity, type ProbeTransaction } from "@masterdns/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { AuthUser } from "../../auth/auth.types.js";
import { DatabaseService } from "../../infrastructure/database.module.js";
import { healthPolicyInputSchema, slotHealthConfigSchema } from "./health-policies.schemas.js";
@Injectable()
export class HealthPoliciesService {
  constructor(private readonly database: DatabaseService) {}
  async save(actor: AuthUser, body: unknown) {
    const input = healthPolicyInputSchema.parse(body);
    if (input.mode === "local") { delete input.groupId; input.consensus = { mode: "all", minimumValid: 1 }; }
    if (input.networkPolicy && actor.role !== "admin") throw new ForbiddenException("Private targets require administrator authorization");
    return this.database.db.transaction(async tx => {
      const owner = await this.lockOwner(tx, actor, input);
      const [config] = await tx.select().from(healthCheckConfigs).where(eq(healthCheckConfigs.id, input.configId)).for("share");
      if (!config?.enabled || (input.slotId ? config.slotId !== input.slotId : config.endpointId !== input.endpointId && config.poolId !== owner.poolId)) throw new NotFoundException("Target configuration not found");
      const parsed = (input.mode === "local" ? healthCheckConfigSchema : externalHealthCheckConfigSchema).parse(config.config);
      if (input.mode !== "local" && parsed.timeoutMs + 1000 > input.executionWindowSeconds * 1000) throw new BadRequestException("Round window must cover check timeout and task pickup");
      const [group] = input.groupId ? await tx.select().from(probeGroups).where(eq(probeGroups.id, input.groupId)).for("share") : [];
      if (input.groupId && group?.ownerUserId !== owner.id) throw new NotFoundException("Probe group not found");
      const members = group ? await tx.select({ agent: probeAgents }).from(probeGroupMembers).innerJoin(probeAgents, eq(probeGroupMembers.probeId, probeAgents.id)).where(eq(probeGroupMembers.groupId, group.id)) : [];
      if (input.mode !== "local" && (!members.length || members.some(({ agent }) => agent.ownerUserId !== owner.id || !(input.family === "4" ? agent.capabilities.ipv4 : agent.capabilities.ipv6)))) throw new BadRequestException("Every group member must support the selected address family");
      const memberIds = members.map(m => m.agent.id); if (input.mode === "mixed") memberIds.push("local");
      const consensus = input.consensus ?? { mode: "majority" as const, minimumValid: Math.max(1, memberIds.length) };
      if (input.mode !== "local" && (consensus.minimumValid > memberIds.length || (consensus.mode === "at_least" && consensus.failureVotes > memberIds.length) || (consensus.mode === "specified" && !memberIds.includes(consensus.specifiedProbeId)))) throw new BadRequestException("Consensus is incompatible with the fixed cohort");
      if (input.slotId && input.mode === "mixed" && (consensus.minimumValid < 2 || (consensus.mode === "specified" && consensus.specifiedProbeId === "local"))) throw new BadRequestException("Cloud authority requires a valid external vote");
      const { expectedRevision, ...rest } = input;
      const values = { ...rest, slotId: input.slotId ?? null, endpointId: input.endpointId ?? null, groupId: input.groupId ?? null, consensus, networkPolicy: input.networkPolicy ?? null };
      const where = input.slotId ? eq(addressHealthPolicies.slotId, input.slotId) : and(eq(addressHealthPolicies.endpointId, input.endpointId!), eq(addressHealthPolicies.family, input.family));
      const [current] = await tx.select().from(addressHealthPolicies).where(where).for("update");
      if (expectedRevision !== undefined && current?.revision !== expectedRevision) throw new ConflictException("Health policy revision changed");
      if (current && Object.entries(values).every(([key, value]) => isDeepStrictEqual(current[key as keyof typeof current], value))) return current;
      const [saved] = current
        ? await tx.update(addressHealthPolicies).set({ ...values, revision: current.revision+1, updatedAt: new Date() }).where(eq(addressHealthPolicies.id, current.id)).returning()
        : await tx.insert(addressHealthPolicies).values(values).returning();
      await tx.update(addressHealthStates).set({ ...resetHealthEvidence, stateChangedAt: new Date(), updatedAt: new Date() }).where(healthTargetWhere(addressHealthStates, input));
      await tx.insert(auditLogs).values({ ownerUserId: owner.id, actorUserId: actor.id, source: "user", action: "health.policy.save", resourceType: "address_health_policy", resourceId: saved!.id, beforeSnapshot: current ?? null, afterSnapshot: saved });
      return saved!;
    });
  }
  async slotConfig(actor: AuthUser, slotId: string) {
    const owner = await this.owner(this.database.db as unknown as ProbeTransaction, { slotId });
    if (!owner || (actor.role !== "admin" && owner.id !== actor.id)) throw new NotFoundException("Slot not found");
    const [config] = await this.database.db.select().from(healthCheckConfigs).where(and(eq(healthCheckConfigs.slotId, slotId), eq(healthCheckConfigs.enabled, true)));
    return config ?? null;
  }
  async saveSlotConfig(actor: AuthUser, slotId: string, body: unknown) {
    const input = slotHealthConfigSchema.parse(body);
    return this.database.db.transaction(async tx => {
      const owner = await this.lockOwner(tx, actor, { slotId });
      const [current] = await tx.select().from(healthCheckConfigs).where(and(eq(healthCheckConfigs.slotId, slotId), eq(healthCheckConfigs.enabled, true))).for("update");
      const [policy] = await tx.select().from(addressHealthPolicies).where(eq(addressHealthPolicies.slotId, slotId)).for("share");
      if (policy && policy.mode !== "local") {
        externalHealthCheckConfigSchema.parse(input.config);
        if (input.config.timeoutMs + 1000 > policy.executionWindowSeconds*1000) throw new BadRequestException("Check timeout exceeds the round window");
      }
      if (input.expectedRevision !== undefined && current?.revision !== input.expectedRevision) throw new ConflictException("Health configuration revision changed");
      if (current && isDeepStrictEqual(healthCheckConfigSchema.parse(current.config), input.config)) return current;
      const values = { slotId, checkerType: input.config.type, config: input.config };
      const [saved] = current ? await tx.update(healthCheckConfigs).set({ ...values, revision: current.revision+1, updatedAt: new Date() }).where(eq(healthCheckConfigs.id, current.id)).returning() : await tx.insert(healthCheckConfigs).values(values).returning();
      await tx.update(addressHealthStates).set({ ...resetHealthEvidence, stateChangedAt: new Date(), updatedAt: new Date() }).where(eq(addressHealthStates.slotId, slotId));
      await tx.insert(auditLogs).values({ ownerUserId: owner.id, actorUserId: actor.id, source: "user", action: "health.slot_config.save", resourceType: "health_check_config", resourceId: saved!.id, afterSnapshot: saved });
      return saved!;
    });
  }
  async list(actor: AuthUser) {
    const rows = await this.database.db.select().from(addressHealthPolicies);
    const visible = [];
    for (const policy of rows) {
      const owner = await this.owner(this.database.db as unknown as ProbeTransaction, policy);
      if (!owner || (actor.role !== "admin" && owner.id !== actor.id)) continue;
      const [state] = await this.database.db.select().from(addressHealthStates).where(healthTargetWhere(addressHealthStates, policy));
      const [config] = await this.database.db.select().from(healthCheckConfigs).where(eq(healthCheckConfigs.id, policy.configId));
      visible.push({ ...policy, state: state ?? null, config: config ?? null });
    }
    return visible;
  }
  async rounds(actor: AuthUser, policyId: string) {
    const [policy] = await this.database.db.select().from(addressHealthPolicies).where(eq(addressHealthPolicies.id, policyId));
    const owner = policy ? await this.owner(this.database.db as unknown as ProbeTransaction, policy) : undefined;
    if (!policy || !owner || (actor.role !== "admin" && owner.id !== actor.id)) throw new NotFoundException("Health policy not found");
    const rounds = await this.database.db.select().from(probeRounds).where(eq(probeRounds.policyId, policy.id)).orderBy(desc(probeRounds.sequence)).limit(100);
    return Promise.all(rounds.map(async round => ({ ...round, observations: await this.database.db.select().from(probeObservations).where(eq(probeObservations.roundId, round.id)) })));
  }
  async stats(actor: AuthUser, policyId: string) {
    const [policy] = await this.database.db.select().from(addressHealthPolicies).where(eq(addressHealthPolicies.id, policyId));
    const owner = policy ? await this.owner(this.database.db as unknown as ProbeTransaction, policy) : undefined;
    if (!policy || !owner || (actor.role !== "admin" && owner.id !== actor.id)) throw new NotFoundException("Health policy not found");
    return this.database.db.select().from(probeObservationStats).where(and(eq(probeObservationStats.targetKey, policy.slotId ? `slot:${policy.slotId}` : `endpoint:${policy.endpointId}`), eq(probeObservationStats.family, policy.family))).orderBy(desc(probeObservationStats.bucketStart)).limit(1000);
  }
  private async lockOwner(tx: ProbeTransaction, actor: AuthUser, target: { slotId?: string | undefined; endpointId?: string | undefined; family?: "4" | "6" }) {
    if (target.slotId) {
      const [slot] = await tx.select().from(managedAddressSlots).where(eq(managedAddressSlots.id, target.slotId)).for("update");
      if (!slot) throw new NotFoundException("Slot not found");
      if (target.family && slot.family !== target.family) throw new BadRequestException("Slot family mismatch");
    } else {
      const [snapshot] = await tx.select().from(endpoints).where(eq(endpoints.id, target.endpointId!));
      if (!snapshot || snapshot.addressMode === "cloud") throw new NotFoundException("Use the shared slot health policy for cloud endpoints");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${snapshot.poolId}))`);
      await tx.select().from(endpoints).where(eq(endpoints.id, snapshot.id)).for("update");
    }
    const owner = await this.owner(tx, target);
    if (!owner || (actor.role !== "admin" && owner.id !== actor.id)) throw new NotFoundException("Target not found");
    return owner;
  }
  private async owner(tx: ProbeTransaction, target: { slotId?: string | null | undefined; endpointId?: string | null | undefined }) {
    if (target.slotId) {
      const [owner] = await tx.select({ id: cloudAccounts.ownerUserId }).from(managedAddressSlots).innerJoin(cloudInterfaces, eq(managedAddressSlots.interfaceId, cloudInterfaces.id)).innerJoin(cloudInstances, eq(cloudInterfaces.instanceId, cloudInstances.id)).innerJoin(cloudAccounts, eq(cloudInstances.accountId, cloudAccounts.id)).where(eq(managedAddressSlots.id, target.slotId));
      return owner ? { ...owner, poolId: null } : undefined;
    }
    const [owner] = await tx.select({ id: endpointPools.ownerUserId, poolId: endpointPools.id }).from(endpoints).innerJoin(endpointPools, eq(endpoints.poolId, endpointPools.id)).where(eq(endpoints.id, target.endpointId!));
    return owner;
  }
}
