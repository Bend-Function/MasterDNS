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
export const rotationResumeSchema = z.object({ expectedPolicyRevision: z.number().int().min(0).optional() }).strict().default({});
export type RotationResumeInput = z.infer<typeof rotationResumeSchema>;

const rotationScheduleTimestampSchema = z.iso.datetime({ offset: true }).nullable();
export const rotationScheduleSchema = z.object({
  slotId: z.uuid(),
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(129600),
  revision: z.number().int().min(0),
  nextRunAt: rotationScheduleTimestampSchema,
  activeIncidentId: z.uuid().nullable(),
  lastStartedAt: rotationScheduleTimestampSchema,
  lastCompletedAt: rotationScheduleTimestampSchema,
  lastHandledIncidentId: z.uuid().nullable(),
  pausedReason: z.string().max(80).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type RotationSchedule = z.infer<typeof rotationScheduleSchema>;

export const rotationScheduleUpdateSchema = z.object({
  revision: z.number().int().min(0),
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(129600),
}).strict();
export type RotationScheduleUpdateInput = z.infer<typeof rotationScheduleUpdateSchema>;

export const rotationScheduleResumeSchema = z.object({
  revision: z.number().int().min(0),
}).strict();
export type RotationScheduleResumeInput = z.infer<typeof rotationScheduleResumeSchema>;
