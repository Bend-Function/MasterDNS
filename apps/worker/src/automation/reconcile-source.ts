import type { OperationSource, PoolReconcileJob } from "@masterdns/contracts";

export function reconcileOperationSource(job: PoolReconcileJob): OperationSource {
  if (job.source) return job.source;
  if (job.trigger === "recovery") return "recovery";
  if (job.trigger === "failure") return "failover";
  return "user";
}
