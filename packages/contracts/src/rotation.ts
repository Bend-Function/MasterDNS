export type CloudStep = {
  id: string;
  action: string;
  resourceKey: string;
  arguments: Record<string, unknown>;
  destructive: boolean;
};

import { z } from "zod";
export const rotationPolicySchema = z.object({
  revision: z.number().int().min(0),
  enabled: z.boolean().default(false),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  minIntervalSeconds: z.number().int().min(60).max(86400).default(60),
  cloudWaitSeconds: z.number().int().min(10).max(3600).default(120),
  candidateWindowSeconds: z.number().int().min(15).max(86400).default(180),
}).strict();
export const rotationStartSchema = z.object({ slotId: z.uuid() }).strict();
export type RotationPolicyInput = z.infer<typeof rotationPolicySchema>;
