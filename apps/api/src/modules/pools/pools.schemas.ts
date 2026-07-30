import { healthCheckConfigSchema } from "@masterdns/contracts";
import { isIP } from "node:net";
import { z } from "zod";

const nullableIp = (family: 4 | 6) => z.union([z.string().refine((value) => isIP(value) === family, `必须是有效的 IPv${family} 地址`), z.null()]);

export const createPoolSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  strategy: z.enum(["primary_backup", "healthy_set", "assignment_pool"]),
  selectionMode: z.enum(["random", "ordered", "round_robin", "least_assigned"]).default("ordered"),
  recoveryMode: z.enum(["automatic", "keep_current", "manual", "delayed"]).default("keep_current"),
  recoveryDelaySeconds: z.number().int().min(0).max(86_400).default(0),
  failureThreshold: z.number().int().min(1).max(20).default(3),
  successThreshold: z.number().int().min(1).max(20).default(3),
  checkIntervalSeconds: z.number().int().min(5).max(3600).default(15),
  checkTimeoutMs: z.number().int().min(100).max(60_000).default(3000),
  switchCooldownSeconds: z.number().int().min(0).max(86_400).default(300),
  allDownReminderSeconds: z.number().int().min(60).max(86_400).default(1800),
});

export const updatePoolSchema = createPoolSchema.omit({ strategy: true }).partial().extend({
  strategy: z.enum(["primary_backup", "healthy_set", "assignment_pool"]).optional(),
}).refine((value) => Object.keys(value).length > 0, "至少提供一个要修改的字段");

export const createEndpointSchema = z.object({
  name: z.string().trim().min(1).max(120),
  addressMode: z.enum(["static", "ddns"]).default("static"),
  priority: z.number().int().min(0).max(1_000_000).default(100),
  lifecycle: z.enum(["enabled", "disabled", "maintenance", "draining"]).default("enabled"),
  ipv4: nullableIp(4).optional(),
  ipv6: nullableIp(6).optional(),
}).superRefine((value, context) => {
  if (value.addressMode === "static" && !value.ipv4 && !value.ipv6) context.addIssue({ code: "custom", message: "静态节点至少需要一个 IP 地址" });
  if (value.addressMode === "ddns" && (value.ipv4 || value.ipv6)) context.addIssue({ code: "custom", message: "DDNS 节点的地址由 Agent 上报" });
});

export const updateEndpointSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  priority: z.number().int().min(0).max(1_000_000).optional(),
  lifecycle: z.enum(["enabled", "disabled", "maintenance", "draining"]).optional(),
  ipv4: nullableIp(4).optional(),
  ipv6: nullableIp(6).optional(),
  forceApply: z.boolean().default(false),
}).refine((value) => Object.keys(value).some((key) => key !== "forceApply"), "至少提供一个要修改的字段");

export const createBindingSchema = z.object({
  zoneId: z.string().uuid(),
  fqdn: z.string().trim().min(1).max(255),
  recordType: z.enum(["A", "AAAA"]),
  ttl: z.number().int().min(1).max(2_147_483_647).default(60),
  providerMetadata: z.record(z.string(), z.unknown()).default({}),
  originalEndpointId: z.string().uuid().optional(),
  takeoverExisting: z.boolean().default(false),
}).superRefine((value, context) => {
  if (value.takeoverExisting && !value.originalEndpointId) {
    context.addIssue({ code: "custom", message: "接管现有记录时必须指定原始节点", path: ["originalEndpointId"] });
  }
});

export const updateBindingSchema = z.object({
  ttl: z.number().int().min(1).max(2_147_483_647).optional(),
  providerMetadata: z.record(z.string(), z.unknown()).optional(),
  originalEndpointId: z.string().uuid().optional(),
  forceApply: z.boolean().default(false),
}).refine((value) => Object.keys(value).some((key) => key !== "forceApply"), "至少提供一个要修改的字段");

export const createHealthCheckSchema = z.object({ config: healthCheckConfigSchema });
export const reconcilePoolSchema = z.object({ force: z.boolean().default(false) });
export const restorePolicyVersionSchema = z.object({ force: z.boolean().default(false) });
export const policyVersionParamSchema = z.coerce.number().int().positive();

export type CreatePoolInput = z.infer<typeof createPoolSchema>;
export type UpdatePoolInput = z.infer<typeof updatePoolSchema>;
export type CreateEndpointInput = z.infer<typeof createEndpointSchema>;
export type UpdateEndpointInput = z.infer<typeof updateEndpointSchema>;
export type CreateBindingInput = z.infer<typeof createBindingSchema>;
export type UpdateBindingInput = z.infer<typeof updateBindingSchema>;
