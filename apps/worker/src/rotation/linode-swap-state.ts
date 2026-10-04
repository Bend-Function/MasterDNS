import { and, eq } from "drizzle-orm";
import { instanceLifecycleBlocksRotation, linodeTemporaryInstanceProof, rotationLeases, rotationResources, type RotationContext, type RotationTransaction } from "@masterdns/db";

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
