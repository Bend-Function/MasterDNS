import { randomUUID } from "node:crypto";

import { consensusPolicySchema, externalHealthCheckConfigSchema, probeTaskSchema, type ConsensusPolicy, type ProbeTask } from "@masterdns/contracts";
import { cloudAccounts, cloudAddresses, cloudInstances, cloudInterfaces, domainBindings, endpointAddresses, endpointPools, endpoints, healthCheckConfigs, managedAddressSlots, probeAgents, probeGroupMembers, probeGroups, probeRoundSequences, probeRounds, probeTasks } from "./schema/index.js";
import { and, eq } from "drizzle-orm";
import type { MasterDnsDatabase } from "./index.js";
export type ProbeTransaction = Parameters<Parameters<MasterDnsDatabase["transaction"]>[0]>[0];
export class ProbeRoundError extends Error { constructor(public readonly status: number, message: string) { super(message); } }


export type CreateProbeRound = {
  includeLocal?: boolean;
  dispatchCapableOnly?: boolean;
  policyId?: string;
  policyRevision?: number;
  slotId?: string | undefined;
  endpointAddressId?: string | undefined;
  configId: string;
  groupId?: string | undefined;
  addressVersion: number;
  consensus: ConsensusPolicy;
  deadline: Date;
  resultExpiresAt: Date;
  hostname?: string;
  networkPolicy?: ProbeTask["networkPolicy"] | undefined;
};

export async function createProbeRound(tx: ProbeTransaction, actor: { id: string; role: string }, input: CreateProbeRound, now = new Date()) {
    if (!!input.slotId === !!input.endpointAddressId) throw new ProbeRoundError(400, "Choose exactly one probe target");
    if (input.deadline <= now || input.resultExpiresAt < input.deadline) throw new ProbeRoundError(400, "Invalid round deadline");
    if (input.networkPolicy && actor.role !== "admin") throw new ProbeRoundError(403, "Private targets require administrator authorization");
    const consensus = consensusPolicySchema.parse(input.consensus);

      let ownerUserId: string;
      let endpointId: string | null = null;
      let poolId: string | null = null;
      let address: string;
      let family: "4" | "6";
      if (input.slotId) {
        const [slot] = await tx.select().from(managedAddressSlots).where(eq(managedAddressSlots.id, input.slotId)).for("update");
        if (!slot) throw new ProbeRoundError(404, "Slot not found");
        const [owner] = await tx.select({ id: cloudAccounts.ownerUserId }).from(cloudInterfaces).innerJoin(cloudInstances, eq(cloudInterfaces.instanceId, cloudInstances.id)).innerJoin(cloudAccounts, eq(cloudInstances.accountId, cloudAccounts.id)).where(eq(cloudInterfaces.id, slot.interfaceId));
        if (!owner || (actor.role !== "admin" && owner.id !== actor.id)) throw new ProbeRoundError(404, "Slot not found");
        ownerUserId = owner.id;
        const version = slot.candidateAddressId ? slot.candidateVersion : slot.currentVersion;
        const addressId = slot.candidateAddressId ?? slot.currentAddressId;
        const [target] = addressId ? await tx.select().from(cloudAddresses).where(eq(cloudAddresses.id, addressId)).for("share") : [];
        if (!target || version < 1 || version !== input.addressVersion) throw new ProbeRoundError(400, "Slot address version is not probeable");
        address = target.address; family = slot.family;
      } else {
        const [candidate] = await tx.select().from(endpointAddresses).where(eq(endpointAddresses.id, input.endpointAddressId!));
        if (!candidate) throw new ProbeRoundError(404, "Address not found");
        // Match endpoint writers' lock order and serialize sequences across replacement addresses.
        const [endpoint] = await tx.select().from(endpoints).where(eq(endpoints.id, candidate.endpointId)).for("update");
        const [target] = await tx.select().from(endpointAddresses).where(eq(endpointAddresses.id, candidate.id)).for("update");
        if (!target || target.state === "previous") throw new ProbeRoundError(404, "Address not found");
        const [pool] = endpoint ? await tx.select().from(endpointPools).where(eq(endpointPools.id, endpoint.poolId)) : [];
        if (!endpoint || !pool || (actor.role !== "admin" && pool.ownerUserId !== actor.id)) throw new ProbeRoundError(404, "Endpoint not found");
        endpointId = endpoint.id; poolId = pool.id; ownerUserId = pool.ownerUserId; address = target.address; family = target.family;
      }
      const [config] = await tx.select().from(healthCheckConfigs).where(eq(healthCheckConfigs.id, input.configId)).for("share");
      let configMatches = !!config?.enabled && (input.slotId ? config.slotId === input.slotId : config.endpointId === endpointId || config.poolId === poolId);
      if (config?.enabled && !input.slotId && config.domainBindingId) {
        const [binding] = await tx.select().from(domainBindings).where(eq(domainBindings.id, config.domainBindingId));
        configMatches = binding?.poolId === poolId;
      }
      if (!config || !configMatches) throw new ProbeRoundError(404, "Probe config not found for target");
      const [group] = input.groupId ? await tx.select().from(probeGroups).where(eq(probeGroups.id, input.groupId)).for("share") : [];
      if ((!group && !input.includeLocal) || (group && group.ownerUserId !== ownerUserId)) throw new ProbeRoundError(404, "Probe group not found for target owner");
      const members = group ? await tx.select({ probeId: probeAgents.id, ownerUserId: probeAgents.ownerUserId, capabilities: probeAgents.capabilities, enabled: probeAgents.enabled, revokedAt: probeAgents.revokedAt }).from(probeGroupMembers).innerJoin(probeAgents, eq(probeGroupMembers.probeId, probeAgents.id)).where(eq(probeGroupMembers.groupId, group.id)) : [];
      if ((!members.length && !input.includeLocal) || members.length > 100 || members.some(m => m.ownerUserId !== ownerUserId)) throw new ProbeRoundError(400, "Invalid probe cohort");
      const memberIds = members.map(m => m.probeId).sort();
      if (input.includeLocal) memberIds.push("local");
      if (consensus.minimumValid > memberIds.length || (consensus.mode === "at_least" && consensus.failureVotes! > memberIds.length) || (consensus.mode === "specified" && !memberIds.includes(consensus.specifiedProbeId!))) throw new ProbeRoundError(400, "Invalid consensus for cohort");
      if (members.length) externalHealthCheckConfigSchema.parse(config.config);
      const payload = probeTaskSchema.parse({ protocol: "probe-agent/v1", taskId: randomUUID(), roundId: randomUUID(), probeId: members[0]?.probeId ?? randomUUID(), leaseId: randomUUID(), addressVersion: input.addressVersion, configVersion: config.revision, address, family: Number(family), config: config.config, deadline: input.deadline.toISOString(), ...(input.hostname ? { hostname: input.hostname } : {}), ...(input.networkPolicy ? { networkPolicy: input.networkPolicy } : {}) });
      const [counter] = await tx.select().from(probeRoundSequences).where(input.slotId ? eq(probeRoundSequences.slotId, input.slotId) : and(eq(probeRoundSequences.endpointId, endpointId!), eq(probeRoundSequences.family, family)));
      const sequence = (counter?.lastSequence ?? 0) + 1;
      // The target row is already locked, so allocation and round creation are one transaction.
      if (counter) await tx.update(probeRoundSequences).set({ lastSequence: sequence }).where(eq(probeRoundSequences.id, counter.id));
      else await tx.insert(probeRoundSequences).values({ slotId: input.slotId, endpointId, family, lastSequence: sequence });
      const [round] = await tx.insert(probeRounds).values({ policyId: input.policyId, policyRevision: input.policyRevision, slotId: input.slotId, endpointId, endpointAddressId: input.endpointAddressId, configId: config.id, groupId: group?.id ?? null, groupRevision: group?.revision ?? null, sequence, addressVersion: input.addressVersion, configVersion: config.revision, address, family, hostname: payload.hostname, config: payload.config, networkPolicy: payload.networkPolicy, memberIds, consensus, deadline: input.deadline, resultExpiresAt: input.resultExpiresAt, createdAt: now }).returning();
      const assignments = members.filter(m => !input.dispatchCapableOnly || (m.enabled && !m.revokedAt && (family === "4" ? m.capabilities.ipv4 : m.capabilities.ipv6)));
      if (assignments.length) await tx.insert(probeTasks).values(assignments.map(m => ({ roundId: round!.id, probeId: m.probeId, createdAt: now })));
      return round!;
}
