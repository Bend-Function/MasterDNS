import { z } from "zod";
import type { CloudRef } from "./cloud.js";

export type CloudLifecycleAction = "start" | "stop" | "delete";
export type CloudPowerState = "running" | "stopped" | "stopped_allocated" | "starting" | "stopping" | "deleting" | "deleted" | "unknown";
export type CloudLifecycleSnapshot = { ref: CloudRef; identity: string; state: CloudPowerState; nativeName?: string };
export type CloudLifecycleReceipt = { operationIds?: string[]; operationId?: string; completed?: boolean };
export type CloudLifecycleStatus = "queued" | "in_flight" | "succeeded" | "failed" | "unknown" | "cancelled";
export type CloudLifecycleOperation = {
  id: string; instanceId: string; action: CloudLifecycleAction; source: "user" | "traffic"; status: CloudLifecycleStatus;
  errorCode: string | null; createdAt: string; updatedAt: string; dispatchedAt: string | null; completedAt: string | null; nextRunAt: string;
};
export type CloudTrafficStopPolicy = {
  instanceId: string; revision: number; enabled: boolean; thresholdBytes: number | null; direction: "total" | "outgoing"; checkIntervalSeconds: number;
  month: string | null; lastUsageBytes: number | null; lastCheckedAt: string | null; lastError: string | null; triggeredAt: string | null;
};
export type CloudInstanceControlView = {
  policy: CloudTrafficStopPolicy; operations: CloudLifecycleOperation[]; blocked: boolean; blockReason: string | null;
  powerHold: "manual_stop" | "traffic_limit" | "deleted" | null;
};
export const cloudLifecycleActionSchema = z.object({ action: z.enum(["start", "stop", "delete"]), confirmation: z.string().max(4096).optional() }).strict();
export const cloudTrafficStopPolicySchema = z.object({
  revision: z.number().int().min(0), enabled: z.boolean(), thresholdBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(), direction: z.enum(["total", "outgoing"]), checkIntervalSeconds: z.number().int().min(60).max(86400).default(3600),
}).strict().refine(value => !value.enabled || value.thresholdBytes !== null, { path: ["thresholdBytes"], message: "Enabled traffic stop requires a threshold" });
export type CloudTrafficStopPolicyInput = z.infer<typeof cloudTrafficStopPolicySchema>;
export type CloudLifecycleActionInput = z.infer<typeof cloudLifecycleActionSchema>;
