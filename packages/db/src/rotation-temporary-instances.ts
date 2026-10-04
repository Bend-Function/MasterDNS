import { isIP } from "node:net";

export type LinodeTemporaryInstanceProof = {
  id: string;
  label: string;
  created: string;
  region: string;
  attemptId: string;
  targetInstanceId: string;
  originalAddress: string;
  candidateAddress?: string;
  type: string;
  accountId: string;
  externalAccountId: string;
};

export function linodeTemporaryInstanceProof(receipt: unknown): LinodeTemporaryInstanceProof | undefined {
  if (!receipt || typeof receipt !== "object") return;
  const after = (receipt as { after?: Record<string, unknown> }).after;
  const proof = after?.temporaryInstance as LinodeTemporaryInstanceProof | undefined;
  if (!proof || typeof proof !== "object" || ![proof.id, proof.label, proof.created, proof.region, proof.attemptId, proof.targetInstanceId, proof.originalAddress, proof.type, proof.accountId, proof.externalAccountId].every(value => typeof value === "string" && value.length > 0)) return;
  if (!/^\d+$/.test(proof.id) || !/^\d+$/.test(proof.targetInstanceId) || proof.id === proof.targetInstanceId || isIP(proof.originalAddress) !== 4
    || (proof.candidateAddress !== undefined && isIP(proof.candidateAddress) !== 4)) return;
  return proof;
}

export function publicRotationTemporaryInstances(
  steps: Array<{ attemptId: string; receipt: unknown }>,
  resources: Array<{ attemptId: string; role: string; snapshot: Record<string, unknown>; cleanupStatus: string }>,
) {
  const instances = new Map<string, { id: string; label: string; region: string; attemptId: string; originalAddress: string; candidateAddress?: string; cleanupStatus: string }>();
  for (const step of steps) {
    const proof = linodeTemporaryInstanceProof(step.receipt);
    if (!proof || proof.attemptId !== step.attemptId) continue;
    const resource = resources.find(row => row.role === "original" && linodeTemporaryInstanceProof(row.snapshot.linodeSwapReceipt)?.id === proof.id);
    const candidateAddress = proof.candidateAddress ?? instances.get(proof.id)?.candidateAddress;
    instances.set(proof.id, { id: proof.id, label: proof.label, region: proof.region, attemptId: proof.attemptId, originalAddress: proof.originalAddress,
      ...(candidateAddress ? { candidateAddress } : {}), cleanupStatus: resource?.cleanupStatus ?? "retained" });
  }
  return [...instances.values()];
}
