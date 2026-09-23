import type { CloudLifecycleAction, CloudLifecycleReceipt, CloudLifecycleSnapshot, CloudPowerState, CloudRef } from "@masterdns/contracts";

import { CloudError } from "./errors.js";

export function sameLifecycleRef(left: CloudRef, right: CloudRef, arm = false): boolean {
  return left.accountId === right.accountId && left.service === right.service && left.region === right.region
    && (arm ? left.instanceId.toLowerCase() === right.instanceId.toLowerCase() : left.instanceId === right.instanceId);
}

export function assertLifecycleSnapshot(snapshot: CloudLifecycleSnapshot, accountId: string, service: CloudRef["service"]): void {
  if (snapshot.ref.accountId !== accountId || snapshot.ref.service !== service || !snapshot.identity)
    throw new CloudError("remote_identity_changed", false);
}

export function assertLifecycleAction(action: CloudLifecycleAction): void {
  if (action !== "start" && action !== "stop" && action !== "delete")
    throw new CloudError("cloud_operation_failed", false);
}

/** Returns a receipt when the provider must not issue another write. */
export function lifecycleNoWrite(action: CloudLifecycleAction, state: CloudPowerState): CloudLifecycleReceipt | undefined {
  if ((action === "start" && state === "running")
    || (action === "stop" && (state === "stopped" || state === "deleted"))
    || (action === "delete" && state === "deleted")) return { completed: true };
  if ((action === "start" && state === "starting")
    || (action === "stop" && state === "stopping")
    || (action === "delete" && state === "deleting")) return { completed: false };
  if (action === "start" && (state === "deleting" || state === "deleted")) throw new CloudError("resource_not_found", false);
  return undefined;
}

export function operationIds(operations: unknown): string[] {
  if (!Array.isArray(operations)) return [];
  return operations.flatMap(operation => {
    const id = (operation as { id?: unknown })?.id;
    return typeof id === "string" && id.length > 0 ? [id] : [];
  });
}
