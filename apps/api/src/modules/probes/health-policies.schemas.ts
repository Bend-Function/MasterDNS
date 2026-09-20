import { z } from "zod";
import { consensusPolicySchema, healthCheckConfigSchema } from "@masterdns/contracts";
export const healthPolicyInputSchema = z.object({
  slotId: z.uuid().optional(), endpointId: z.uuid().optional(), family: z.enum(["4", "6"]), configId: z.uuid(),
  mode: z.enum(["local", "external", "mixed"]).default("external"), groupId: z.uuid().optional(),
  expectedRevision: z.number().int().min(1).optional(), consensus: consensusPolicySchema.optional(),
  checkIntervalSeconds: z.number().int().min(1).max(86400).default(15),
  executionWindowSeconds: z.number().int().min(1).max(300).default(10),
  resultExpirySeconds: z.number().int().min(1).max(86400).default(60),
  successThreshold: z.number().int().min(1).max(100).default(3), failureThreshold: z.number().int().min(1).max(100).default(3),
  networkPolicy: z.object({ allowedPrivateCIDRs: z.array(z.union([z.cidrv4(), z.cidrv6()])).min(1).max(64) }).strict().optional(),
}).strict().superRefine((p, c) => {
  if (!!p.slotId === !!p.endpointId) c.addIssue({ code: "custom", message: "Choose exactly one target" });
  if (p.slotId && p.mode === "local") c.addIssue({ code: "custom", path: ["mode"], message: "Cloud slots require external probe authority" });
  if (p.mode !== "local" && !p.groupId) c.addIssue({ code: "custom", path: ["groupId"], message: "External votes require a probe group" });
  if (p.checkIntervalSeconds < p.executionWindowSeconds || p.resultExpirySeconds < p.executionWindowSeconds) c.addIssue({ code: "custom", message: "Interval and expiry must cover the execution window" });
});
export const slotHealthConfigSchema = z.object({ config: healthCheckConfigSchema, expectedRevision: z.number().int().min(1).optional() }).strict();
