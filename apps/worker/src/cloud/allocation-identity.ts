import type { CloudStepResult } from "@masterdns/cloud-providers";

/** Durable allocation proof is independent of the latest inventory observation. */
export type AllocationIdentity = { allocationId: string | null; resourceId: string | null; resourceGuid: string | null };
export function allocationIdentity(receipt: CloudStepResult): AllocationIdentity {
  const metadata = receipt.after?.addressMetadata as Record<string, unknown> | undefined;
  return { allocationId: receipt.allocationId ?? null, resourceId: receipt.resourceId ?? null,
    resourceGuid: typeof metadata?.resourceGuid === "string" && metadata.resourceGuid ? metadata.resourceGuid : null };
}
