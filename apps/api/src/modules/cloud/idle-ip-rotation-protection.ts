import { isIP } from "node:net";
import { rotationArguments, rotationResourceName, type IdleStaticIp } from "@masterdns/cloud-providers";
import type { CloudStep } from "@masterdns/contracts";

export type IdleIpRotationEvidence = {
  stepId: string;
  attemptId: string;
  accountId: string;
  externalAccountId: string;
  region: string;
  instanceId: string;
  interfaceId: string;
  slotId: string;
  plan: unknown;
  receipt: unknown;
  resources: unknown;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_rotation_evidence");
  return value as Record<string, unknown>;
}

export function unresolvedRotationProtectsIdleIp(target: IdleStaticIp, evidence: IdleIpRotationEvidence): boolean {
  if (target.region !== evidence.region) return false;
  const action = typeof evidence.plan === "object" && evidence.plan !== null && "action" in evidence.plan ? evidence.plan.action : undefined;
  const stored = Array.isArray(evidence.resources) && evidence.resources.some(resource => {
    if (typeof resource !== "object" || resource === null || Array.isArray(resource)) return false;
    const value = resource as Record<string, unknown>;
    return ((value.role === "candidate" && action !== "lightsail.static-ip.release")
      || (value.role === "original" && action === "lightsail.static-ip.release" && value.cleanupStepId === evidence.stepId))
      && (value.allocationId === target.name || value.resourceId === target.arn || value.address === target.address);
  });
  try {
    const plan = record(evidence.plan) as unknown as CloudStep;
    const args = rotationArguments(plan), slot = args.slot;
    if (plan.id !== evidence.stepId || args.attemptId !== evidence.attemptId
      || slot.service !== "lightsail" || slot.accountId !== evidence.accountId || slot.region !== evidence.region
      || slot.instanceId !== evidence.instanceId || slot.interfaceId !== evidence.interfaceId || slot.slotId !== evidence.slotId
      || isIP(slot.address) !== slot.family || !Array.isArray(evidence.resources)) return stored;
    if (evidence.receipt !== null) record(evidence.receipt);
    const original = args.before.interfaces.find(iface => iface.id === slot.interfaceId)?.addresses.find(address => address.family === slot.family && address.address === slot.address);
    if (!original) return stored;
    if (["lightsail.ipv6.disable", "lightsail.ipv6.enable"].includes(plan.action)) return stored;
    const candidate = ["lightsail.static-ip.allocate", "lightsail.static-ip.attach"].includes(plan.action);
    if ((!candidate && plan.action !== "lightsail.static-ip.release") || slot.family !== 4) return stored;
    if (args.phase !== (candidate ? "rotation" : "post_publish_cleanup")) return stored;
    const expectedName = candidate ? rotationResourceName(plan) : original.allocationId;
    if (typeof expectedName !== "string" || !expectedName.trim()) return stored;
    const identities: Array<Record<string, unknown>> = [candidate ? { allocationId: expectedName } : original];
    if (!candidate && args.ownershipSnapshot !== undefined) {
      const proof = record(args.ownershipSnapshot);
      if (proof.accountId !== slot.accountId || proof.instanceId !== slot.instanceId || proof.interfaceId !== slot.interfaceId
        || proof.address !== slot.address || proof.allocationId !== expectedName
        || (original.resourceId !== undefined && proof.resourceId !== original.resourceId)) return stored || expectedName === target.name;
      identities.push(proof);
    }
    for (const receipt of [evidence.receipt, args.receipt, candidate ? args.candidateReceipt : args.cleanupReceipt]) {
      if (receipt !== undefined && receipt !== null) {
        const value = record(receipt);
        if ([value.allocationId, value.remoteId].some(name => name !== undefined && name !== null && name !== expectedName)) return stored || expectedName === target.name;
        identities.push({ allocationId: value.allocationId, remoteId: value.remoteId, resourceId: value.resourceId, address: value.candidateAddress });
      }
    }
    for (const resource of evidence.resources) {
      const value = record(resource);
      if (value.role !== "original" && value.role !== "candidate") return stored || expectedName === target.name;
      if (value.role === (candidate ? "candidate" : "original") && (value.cleanupStepId === evidence.stepId || value.allocationId === expectedName)) identities.push(value);
    }
    return stored || identities.some(identity => {
      let matches = false;
      for (const [key, expected] of [["allocationId", target.name], ["remoteId", target.name], ["resourceId", target.arn], ["address", target.address]] as const) {
        const value = identity[key];
        if (value === undefined || value === null) continue;
        if (typeof value !== "string" || !value.trim()) throw new Error("invalid_rotation_evidence");
        if (key === "address" && isIP(value) !== 4) throw new Error("invalid_rotation_evidence");
        if (key === "resourceId") {
          const parts = value.split(":");
          if (parts.length !== 6 || parts[0] !== "arn" || parts[2] !== "lightsail" || parts[3] !== evidence.region
            || parts[4] !== evidence.externalAccountId || !parts[5]?.startsWith("StaticIp/") || parts[5].length <= 9) throw new Error("invalid_rotation_evidence");
        }
        if (value === expected) matches = true;
      }
      return matches;
    });
  } catch { return stored; }
}
