import { z } from "zod";

export const cloudCredentialsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("access_key"), accessKeyId: z.string().trim().min(8).max(128), secretAccessKey: z.string().min(16).max(256), sessionToken: z.string().min(1).max(8192).optional() }).strict(),
  z.object({ kind: z.literal("role"), roleArn: z.string().regex(/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/.+$/).max(2048).optional(), externalId: z.string().min(1).max(1224).optional() }).strict(),
]);
export const cloudRegionsSchema = z.array(z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d+$/).max(80)).min(1).max(100).refine((regions) => new Set(regions).size === regions.length, "Regions must be unique").nullable();
export const cloudRegionsUpdateSchema = z.object({ regions: cloudRegionsSchema }).strict();
export const createCloudAccountSchema = z.object({
  name: z.string().trim().min(1).max(120), regions: cloudRegionsSchema.optional(), provider: z.literal("aws"), ownerUserId: z.string().uuid().optional(), credentials: cloudCredentialsSchema,
}).strict();
export const cloudCredentialsUpdateSchema = z.object({ credentials: cloudCredentialsSchema }).strict();
export const cloudEnabledSchema = z.object({ enabled: z.boolean() }).strict();
export const cloudAuthorizationSchema = z.object({
  revision: z.number().int().min(0), managed: z.boolean(),
  allowIpv4Rotation: z.boolean().optional(), allowIpv6Rotation: z.boolean().optional(),
  allowStopStart: z.boolean().optional(), allowReleaseAddress: z.boolean().optional(),
}).strict();
export const cloudBindingSchema = z.object({
  zoneId: z.string().uuid(), fqdn: z.string().trim().min(1).max(255), recordType: z.enum(["A", "AAAA"]), slotId: z.string().uuid(),
  takeoverExisting: z.boolean().default(false), poolId: z.string().uuid().optional(),
}).strict();
export type CreateCloudAccountInput = z.infer<typeof createCloudAccountSchema>;
export type CloudCredentialsUpdateInput = z.infer<typeof cloudCredentialsUpdateSchema>;
export type CloudAuthorizationInput = z.infer<typeof cloudAuthorizationSchema>;
export type CloudBindingInput = z.infer<typeof cloudBindingSchema>;
