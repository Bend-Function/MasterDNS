import type { CloudService, CloudStep, SlotRef } from "@masterdns/contracts";
import type { CloudInventory, CloudStepResult, CleanupPlanOptions } from "@masterdns/cloud-providers";
import type { RotationContext, RotationTransaction, rotationResources } from "@masterdns/db";
import { linodePersistenceExtension } from "./linode-swap-state.js";

export type PersistedRotationResource = typeof rotationResources.$inferSelect;
export interface RotationPersistenceExtension {
  authorizeStep(tx: RotationTransaction, context: RotationContext, incidentId: string, plan: CloudStep, allocation: unknown, now: Date): Promise<string | undefined>;
  receiptsConflict(old: unknown, next: unknown): boolean;
  recordReceipt(tx: RotationTransaction, context: RotationContext, incidentId: string, attemptId: string, receipt: CloudStepResult, plan: CloudStep, applied: boolean, now: Date, stepId: string): Promise<boolean>;
  hasCleanupProof(resource: PersistedRotationResource): boolean;
  cleanupPlan(context: RotationContext, resource: PersistedRotationResource, slot: SlotRef, before: CloudInventory, options: CleanupPlanOptions): CloudStep[] | undefined;
  invalidatesHealth(plan: CloudStep): boolean;
  completeCleanup(tx: RotationTransaction, incidentId: string, plan: CloudStep): Promise<void>;
}
const defaults: RotationPersistenceExtension = {
  authorizeStep: async () => undefined,
  receiptsConflict: () => false,
  recordReceipt: async () => true,
  hasCleanupProof: () => false,
  cleanupPlan: () => undefined,
  invalidatesHealth: () => false,
  completeCleanup: async () => {},
};
const extensions: Partial<Record<CloudService, RotationPersistenceExtension>> = { linode: linodePersistenceExtension };
export function rotationPersistenceExtension(service: CloudService): RotationPersistenceExtension {
  return extensions[service] ?? defaults;
}
/** Persisted option names remain compatible with existing plans. */
export function persistedRotationOptions(context: RotationContext) {
  return { allowStop: context.authorization!.allowStopStart,
    linodeRestartMode: context.policy?.linodeRestartMode ?? "reboot",
    linodeIpv4Strategy: context.policy?.linodeIpv4Strategy ?? "additional_ipv4",
    linodeSwapPlan: context.policy?.linodeSwapPlan ?? "g6-nanode-1",
    allowTemporaryInstance: context.policy?.linodeAllowTemporaryInstance ?? false };
}
export function persistedCleanupOptions(context: RotationContext, plan?: CloudStep) {
  return { allowStop: context.authorization!.allowStopStart,
    linodeRestartMode: plan?.arguments.linodeRestartMode === "stop_start" ? "stop_start" as const : "reboot" as const,
    linodeSwapPlan: typeof plan?.arguments.linodeSwapPlan === "string" ? plan.arguments.linodeSwapPlan : "g6-nanode-1",
    allowTemporaryInstance: context.policy?.linodeAllowTemporaryInstance ?? false };
}
