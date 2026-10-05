import { z } from "zod";
import { cloudCredentialsSchema, cloudProviderIds, credentialsMatchProvider, validCloudRegion } from "@masterdns/contracts";
export { cloudCredentialsSchema } from "@masterdns/contracts";

export const cloudRegionsSchema = z.array(z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(80)).min(1).max(100).refine((regions) => new Set(regions).size === regions.length, "Regions must be unique").nullable();
export const cloudRegionsUpdateSchema = z.object({ regions: cloudRegionsSchema }).strict();
export const createCloudAccountSchema = z.object({
  name: z.string().trim().min(1).max(120), regions: cloudRegionsSchema.optional(), provider: z.enum(cloudProviderIds), ownerUserId: z.string().uuid().optional(), proxyProfileId: z.string().uuid().nullable().optional(), credentials: cloudCredentialsSchema,
}).strict().superRefine((input, context) => {
  if (!credentialsMatchProvider(input.provider, input.credentials)) context.addIssue({ code: "custom", path: ["credentials"], message: "Credentials do not match provider" });
  if (input.regions?.some(region => !validCloudRegion(input.provider, region))) context.addIssue({ code: "custom", path: ["regions"], message: "Invalid provider region" });
});
export const cloudCredentialsUpdateSchema = z.object({ credentials: cloudCredentialsSchema }).strict();
export const cloudEnabledSchema = z.object({ enabled: z.boolean() }).strict();
export const cloudAuthorizationSchema = z.object({
  revision: z.number().int().min(0), managed: z.boolean(),
  allowIpv4Rotation: z.boolean().optional(), allowIpv6Rotation: z.boolean().optional(),
  allowStopStart: z.boolean().optional(), allowDelete: z.boolean().optional(), allowReleaseAddress: z.boolean().optional(),
}).strict();
export const cloudBindingSchema = z.object({
  zoneId: z.string().uuid(), fqdn: z.string().trim().min(1).max(255), recordType: z.enum(["A", "AAAA"]), slotId: z.string().uuid(),
  takeoverExisting: z.boolean().default(false), poolId: z.string().uuid().optional(),
}).strict();
export type CreateCloudAccountInput = z.infer<typeof createCloudAccountSchema>;
export type CloudCredentialsUpdateInput = z.infer<typeof cloudCredentialsUpdateSchema>;
export type CloudAuthorizationInput = z.infer<typeof cloudAuthorizationSchema>;
export type CloudBindingInput = z.infer<typeof cloudBindingSchema>;
