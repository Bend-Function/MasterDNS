import { and, eq, isNull } from "drizzle-orm";
import { forgetDeletedLinodeTemporaryInstance, instanceLifecycleBlocksRotation, linodeTemporaryInstanceProof, rotationLeases, rotationResources, type RotationContext, type RotationTransaction } from "@masterdns/db";
import { planCloudRotationCleanup, type CloudStepResult } from "@masterdns/cloud-providers";
import type { RotationPersistenceExtension } from "./rotation-persistence-extensions.js";

export async function recordLinodeSwapState(tx: RotationTransaction, context: RotationContext, incidentId: string, attemptId: string, receipt: unknown, appliedSwap: boolean, now: Date, stepId: string): Promise<boolean> {
  const proof = linodeTemporaryInstanceProof(receipt);
  if (!proof || proof.accountId !== context.account.id || proof.externalAccountId !== context.account.externalAccountId || proof.targetInstanceId !== context.instance.externalId || proof.region !== context.instance.region || proof.attemptId !== attemptId) return false;
  const physicalKey = JSON.stringify(["linode", proof.externalAccountId, "linode", proof.region, proof.id]);
  if (await instanceLifecycleBlocksRotation(tx, physicalKey)) return false;
  await tx.insert(rotationLeases).values({ physicalKey }).onConflictDoNothing();
  const [lease] = await tx.select().from(rotationLeases).where(eq(rotationLeases.physicalKey, physicalKey)).for("update");
  if (!lease || (lease.incidentId && lease.incidentId !== incidentId) || (lease.unresolvedStepId && lease.unresolvedStepId !== stepId) || (lease.holder && lease.expiresAt > now)) return false;
  await tx.update(rotationLeases).set({ incidentId, updatedAt: now }).where(eq(rotationLeases.physicalKey, physicalKey));
  if (appliedSwap) {
    const [original] = await tx.select().from(rotationResources).where(and(eq(rotationResources.attemptId, attemptId), eq(rotationResources.role, "original"))).for("update");
    if (!original || original.address !== proof.originalAddress) return false;
    await tx.update(rotationResources).set({ attached: false, snapshot: { ...original.snapshot, linodeSwapReceipt: receipt } }).where(eq(rotationResources.id, original.id));
  }
  return true;
}

/** Linode-specific SQL/proof handling stays outside network adapters and orchestrators. */
export const linodePersistenceExtension: RotationPersistenceExtension = {
  authorizeStep: async (tx, context, incidentId, plan, allocation, now) => {
    if (["linode.instance.reboot", "linode.instance.stop", "linode.instance.start"].includes(plan.action) && !context.authorization!.allowStopStart) throw new Error("stop_not_authorized");
    const cleanup = plan.action === "linode.swap.delete";
    if (!cleanup && plan.arguments.linodeIpv4Strategy !== "instance_swap") return;
    if (!context.policy?.linodeAllowTemporaryInstance) throw new Error("rotation_temporary_instance_not_authorized");
    if (!cleanup && plan.action === "linode.swap.allocate") return;
    const proof = linodeTemporaryInstanceProof(cleanup ? plan.arguments.linodeSwapReceipt : allocation);
    const key = proof && JSON.stringify(["linode", context.account.externalAccountId, "linode", context.instance.region, proof.id]);
    const [peer] = key ? await tx.select().from(rotationLeases).where(eq(rotationLeases.physicalKey, key)).for("update") : [];
    if (!peer || peer.incidentId !== incidentId || peer.unresolvedStepId || (peer.holder && peer.expiresAt > now)) throw new Error("rotation_temporary_instance_busy");
    return key;
  },
  receiptsConflict: (old, next) => {
    const oldHelper = linodeTemporaryInstanceProof(old), nextHelper = linodeTemporaryInstanceProof(next);
    return !!(oldHelper && nextHelper && oldHelper.id !== nextHelper.id);
  },
  recordReceipt: async (tx, context, incidentId, attemptId, receipt, plan, applied, now, stepId) => {
    if (plan.arguments.linodeIpv4Strategy !== "instance_swap" || !receipt.after?.temporaryInstance) return true;
    return recordLinodeSwapState(tx, context, incidentId, attemptId, receipt, plan.action === "linode.ipv4.swap" && applied, now, stepId);
  },
  hasCleanupProof: resource => !!linodeTemporaryInstanceProof(resource.snapshot.linodeSwapReceipt),
  cleanupPlan: (context, resource, slot, before, options) => {
    const swapReceipt = resource.snapshot.linodeSwapReceipt as CloudStepResult | undefined;
    if (!swapReceipt) return;
    const proof = linodeTemporaryInstanceProof(swapReceipt);
    if (resource.role !== "original" || !proof || proof.originalAddress !== resource.address || proof.attemptId !== resource.attemptId || swapReceipt.after?.swapVerified !== true) throw new Error("cleanup_identity_changed");
    const original = before.interfaces.find(iface => iface.id === slot.interfaceId)?.addresses.find(address => address.address === resource.address && address.family === slot.family);
    if (!original || !resource.allocationId || original.allocationId !== resource.allocationId || original.resourceId !== resource.resourceId) throw new Error("resource_ownership_ambiguous");
    return planCloudRotationCleanup({ ...slot, address: resource.address }, before, { ...options,
      linodeIpv4Strategy: "instance_swap", linodeSwapReceipt: swapReceipt,
      ownershipSnapshot: { accountId: slot.accountId, instanceId: slot.instanceId, interfaceId: slot.interfaceId, address: resource.address, allocationId: resource.allocationId, ...(resource.resourceId ? { resourceId: resource.resourceId } : {}) },
    });
  },
  invalidatesHealth: plan => ["linode.instance.reboot", "linode.instance.start"].includes(plan.action),
  completeCleanup: async (tx, incidentId, plan) => {
    if (plan.action !== "linode.swap.delete") return;
    const proof = linodeTemporaryInstanceProof(plan.arguments.linodeSwapReceipt);
    if (!proof) return;
    await tx.update(rotationLeases).set({ incidentId: null, updatedAt: new Date() })
      .where(and(eq(rotationLeases.physicalKey, JSON.stringify(["linode", proof.externalAccountId, "linode", proof.region, proof.id])), eq(rotationLeases.incidentId, incidentId), isNull(rotationLeases.unresolvedStepId)));
    await forgetDeletedLinodeTemporaryInstance(tx, proof);
  },
};
