import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { and, eq, ne } from "drizzle-orm";
import { addressHealthPolicies, addressHealthStates, auditLogs, healthCheckConfigs, probeGroups, rotationAttempts, rotationBudgetSegments, rotationIncidents, rotationLeases, rotationPolicies, rotationSteps } from "./schema/index.js";
import { hasFreshHealthEvidence } from "./address-health.js";
import { databaseNow, rotationAuthorizationError, type RotationContext, type RotationTransaction } from "./rotation-context.js";

export async function lockRotationHealth(tx: RotationTransaction, c: RotationContext) {
  const [policy] = await tx.select().from(addressHealthPolicies).where(eq(addressHealthPolicies.slotId, c.slot.id)).for("share");
  const [config] = policy ? await tx.select().from(healthCheckConfigs).where(eq(healthCheckConfigs.id, policy.configId)).for("share") : [];
  const [group] = policy?.groupId ? await tx.select().from(probeGroups).where(eq(probeGroups.id, policy.groupId)).for("share") : [];
  const [state] = await tx.select().from(addressHealthStates).where(eq(addressHealthStates.slotId, c.slot.id)).for("update");
  const configured = !!policy && policy.family === c.slot.family && (policy.mode === "external" || policy.mode === "mixed") && !!config?.enabled && config.slotId === c.slot.id && !!group && group.ownerUserId === c.account.ownerUserId;
  const matches = configured && !!state && state.family === c.slot.family && state.addressId === c.address?.id && state.addressVersion === c.addressVersion
    && state.configId === config.id && state.configVersion === config.revision && state.policyId === policy.id && state.policyRevision === policy.revision && state.groupRevision === group.revision;
  const now = await databaseNow(tx);
  return { policy, config, group, state, configured, matches, now,
    success: matches && hasFreshHealthEvidence(state, "success", policy, now) && state.consecutiveSuccesses >= policy.successThreshold,
    failure: matches && hasFreshHealthEvidence(state, "failure", policy, now) && state.consecutiveFailures >= policy.failureThreshold };
}
export type RotationHealth = Awaited<ReturnType<typeof lockRotationHealth>>;
export function healthRevisions(h: RotationHealth) {
  if (!h.configured || !h.policy || !h.config || !h.group) throw new Error("external_health_required");
  return { healthPolicyId: h.policy.id, healthPolicyRevision: h.policy.revision, configId: h.config.id, configRevision: h.config.revision, groupId: h.group.id, groupRevision: h.group.revision };
}
export function healthRevisionMatches(incident: typeof rotationIncidents.$inferSelect, h: RotationHealth) {
  return h.configured && incident.healthPolicyId === h.policy?.id && incident.healthPolicyRevision === h.policy?.revision && incident.configId === h.config?.id && incident.configRevision === h.config?.revision && incident.groupId === h.group?.id && incident.groupRevision === h.group?.revision;
}
export async function createRotationIncident(tx: RotationTransaction, c: RotationContext, sourceEventId: string, actorUserId?: string) {
  const [existing] = await tx.select().from(rotationIncidents).where(and(eq(rotationIncidents.slotId, c.slot.id), ne(rotationIncidents.status, "complete"))).for("update");
  if (existing) {
    if (existing.trigger !== "health") throw new Error("rotation_active_conflict");
    return existing;
  }
  const [source] = await tx.select().from(rotationIncidents).where(and(eq(rotationIncidents.slotId, c.slot.id), eq(rotationIncidents.sourceEventId, sourceEventId)));
  if (source) {
    if (source.trigger !== "health") throw new Error("rotation_active_conflict");
    return source;
  }
  const error = rotationAuthorizationError(c); if (error) throw new Error(error);
  const h = await lockRotationHealth(tx, c);
  if (!h.failure) throw new Error("confirmed_failure_required");
  const currentSegmentId = randomUUID();
  const [incident] = await tx.insert(rotationIncidents).values({ ownerUserId: c.account.ownerUserId, slotId: c.slot.id, family: c.slot.family, physicalKey: c.physicalKey, sourceEventId, currentSegmentId,
    releaseOldAddress: true,
    authorizationRevision: c.authorization!.revision, policyRevision: c.policy!.revision, addressVersion: c.addressVersion, ...healthRevisions(h), nextRunAt: h.now, nextAttemptAt: h.now }).returning();
  await tx.insert(rotationBudgetSegments).values({ id: currentSegmentId, incidentId: incident!.id, maxAttempts: c.policy!.maxAttempts, actorUserId });
  await rotationAudit(tx, incident!, "rotation.start", actorUserId, { sourceEventId });
  return incident!;
}
export async function createManualRotationIncident(tx: RotationTransaction, c: RotationContext, sourceEventId: string, actorUserId: string) {
  const [existing] = await tx.select().from(rotationIncidents).where(and(eq(rotationIncidents.slotId, c.slot.id), ne(rotationIncidents.status, "complete"))).for("update");
  if (existing) {
    if (existing.trigger !== "manual") throw new Error("rotation_active_conflict");
    return existing;
  }
  const [source] = await tx.select().from(rotationIncidents).where(and(eq(rotationIncidents.slotId, c.slot.id), eq(rotationIncidents.sourceEventId, sourceEventId)));
  if (source) {
    if (source.trigger !== "manual") throw new Error("rotation_active_conflict");
    return source;
  }
  if (c.slot.candidateAddressId && c.slot.candidateAddressId !== c.slot.currentAddressId) throw new Error("rotation_candidate_exists");
  const error = rotationAuthorizationError(c, "manual"); if (error) throw new Error(error);
  const capabilityError = manualRotationCapabilityError(c); if (capabilityError) throw new Error(capabilityError);
  const [policy] = c.policy ? [c.policy] : await tx.insert(rotationPolicies).values({ slotId: c.slot.id, enabled: false }).returning();
  if (!policy) throw new Error("rotation_policy_missing");
  const now = await databaseNow(tx);
  const currentSegmentId = randomUUID();
  const [incident] = await tx.insert(rotationIncidents).values({ ownerUserId: c.account.ownerUserId, slotId: c.slot.id, family: c.slot.family, physicalKey: c.physicalKey, sourceEventId, trigger: "manual", currentSegmentId,
    releaseOldAddress: true,
    authorizationRevision: c.authorization!.revision, policyRevision: policy.revision, addressVersion: c.addressVersion, nextRunAt: now, nextAttemptAt: now }).returning();
  await tx.insert(rotationBudgetSegments).values({ id: currentSegmentId, incidentId: incident!.id, maxAttempts: 1, actorUserId });
  await rotationAudit(tx, incident!, "rotation.manual", actorUserId, { sourceEventId });
  return incident!;
}
export async function resumeRotationIncident(tx: RotationTransaction, c: RotationContext, id: string, actorUserId: string) {
  const [incident] = await tx.select().from(rotationIncidents).where(eq(rotationIncidents.id, id)).for("update");
  if (!incident || incident.status === "complete") throw new Error("rotation_not_resumable");
  const error = rotationAuthorizationError(c, incident.trigger); if (error) throw new Error(error);
  if (!c.policy) throw new Error("rotation_policy_missing");
  const h = incident.trigger === "health" ? await lockRotationHealth(tx, c) : { now: await databaseNow(tx) };
  const revisions = incident.trigger === "health" ? healthRevisions(h as RotationHealth) : {};
  const [lease] = await tx.select().from(rotationLeases).where(eq(rotationLeases.physicalKey, c.physicalKey)).for("update");
  if (lease?.unresolvedStepId) throw new Error("cloud_observation_required");
  if (incident.status === "active") return incident;
  const [attempt] = incident.currentAttemptId ? await tx.select().from(rotationAttempts).where(eq(rotationAttempts.id, incident.currentAttemptId)).for("update") : [];
  const continuingCloud = incident.phase === "cloud" && !!attempt?.charged;
  if (incident.phase === "cloud" && attempt) {
    const steps = await tx.select().from(rotationSteps).where(eq(rotationSteps.attemptId, attempt.id)).for("update");
    if (steps.some(s => !["prepared", "rejected_no_effect", "applied"].includes(s.status))) throw new Error("cloud_observation_required");
    if (!continuingCloud) await tx.update(rotationAttempts).set({ status: "abandoned" }).where(eq(rotationAttempts.id, attempt.id));
    else for (const step of steps.filter(s => s.status === "rejected_no_effect")) {
      // Explicit fresh authorization may retry a conclusively rejected step of
      // this charged plan. The original allocation, charge and receipts survive.
      await tx.update(rotationSteps).set({ status: "prepared", errorCode: null, retryAt: null, updatedAt: h.now }).where(eq(rotationSteps.id, step.id));
      await rotationAudit(tx, incident, "rotation.step_reprepared", actorUserId, { stepId: step.id, attemptId: attempt.id, previousStatus: step.status, previousErrorCode: step.errorCode, previousRetryAt: step.retryAt });
    }
  }
  const segmentId = incident.trigger === "manual" ? incident.currentSegmentId : randomUUID();
  if (incident.trigger === "health") await tx.insert(rotationBudgetSegments).values({ id: segmentId, incidentId: id, maxAttempts: c.policy.maxAttempts, actorUserId });
  const [updated] = await tx.update(rotationIncidents).set({ status: "active", currentSegmentId: continuingCloud || incident.trigger === "manual" ? incident.currentSegmentId : segmentId, pendingSegmentId: incident.trigger === "health" && continuingCloud ? segmentId : null, ...(incident.phase === "cloud" && !continuingCloud ? { currentAttemptId: null } : {}), pausedByUserId: null, errorCode: null,
    authorizationRevision: c.authorization!.revision, policyRevision: c.policy!.revision, addressVersion: c.addressVersion, ...revisions, nextRunAt: h.now, updatedAt: h.now }).where(eq(rotationIncidents.id, id)).returning();
  await rotationAudit(tx, updated!, "rotation.resume", actorUserId, { previousSegmentId: incident.currentSegmentId, segmentId });
  return updated!;
}

function manualRotationCapabilityError(c: RotationContext): string | undefined {
  if (c.account.provider !== "aws" || (c.instance.service !== "ec2" && c.instance.service !== "lightsail") || c.slot.family !== "4" || c.slot.currentAddressId !== c.address?.id || isIP(c.address.address) !== 4) return "rotation_aws_public_ipv4_required";
  const providerMetadata = record(c.address.metadata.providerMetadata);
  if (providerMetadata?.awsAddressScope === "private" || isPrivateIpv4(c.address.address)) return "rotation_private_ipv4_unsupported";
  const primaryAddresses = Array.isArray(c.iface?.metadata.primaryAddresses) ? c.iface.metadata.primaryAddresses : [];
  const primary = primaryAddresses.includes(c.address.address);
  if (c.instance.service === "ec2") {
    if (!c.address.remoteAllocationId && !primary) return "rotation_capability_unavailable";
    if (c.address.remoteAllocationId && !primary && typeof c.address.metadata.privateAddress !== "string") return "rotation_capability_unavailable";
    if (!c.address.remoteAllocationId && c.iface?.metadata.deviceIndex !== 0) return "rotation_capability_unavailable";
  }
  if (c.instance.service === "lightsail" && c.instance.metadata.ipv6Only !== false) return "rotation_capability_unavailable";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isPrivateIpv4(address: string): boolean {
  const [first = 0, second = 0] = address.split(".").map(Number);
  return first === 10 || first === 127 || first === 0 || first >= 224 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254) || (first === 100 && second >= 64 && second <= 127);
}
export async function rotationAudit(tx: RotationTransaction, incident: typeof rotationIncidents.$inferSelect, action: string, actorUserId?: string, afterSnapshot?: unknown) {
  await tx.insert(auditLogs).values({ ownerUserId: incident.ownerUserId, actorUserId, source: actorUserId ? "user" : "failover", action, resourceType: "rotation", resourceId: incident.id, afterSnapshot });
}
