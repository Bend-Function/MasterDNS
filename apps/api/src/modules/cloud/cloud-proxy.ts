import { parseCloudProxyUrl } from "@masterdns/cloud-providers";
import { z } from "zod";

const proxyUrl = z.string().min(1).max(4_096).superRefine((value, context) => {
  try { parseCloudProxyUrl(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid SOCKS proxy URL" }); }
});

export const cloudProxyUpdateSchema = z.object({ proxyUrl: proxyUrl.nullable() }).strict();
export const cloudProxyCheckSchema = z.object({ proxyUrl: proxyUrl.optional() }).strict();
export const cloudProxyProfileSchema = z.object({ name: z.string().trim().min(1).max(120), proxyUrl, ownerUserId: z.string().uuid().optional() }).strict();
export const cloudProxyProfileUpdateSchema = z.object({ name: z.string().trim().min(1).max(120), proxyUrl: proxyUrl.optional() }).strict();
export const cloudProxySelectionSchema = z.object({ proxyId: z.string().uuid().nullable() }).strict();

export type CloudProxyUpdateInput = z.infer<typeof cloudProxyUpdateSchema>;
export type CloudProxyCheckInput = z.infer<typeof cloudProxyCheckSchema>;
export type CloudProxyProfileInput = z.infer<typeof cloudProxyProfileSchema>;
export type CloudProxyProfileUpdateInput = z.infer<typeof cloudProxyProfileUpdateSchema>;
export type CloudProxyStatus = { configured: boolean; endpoint: string | null };
export type CloudProxyCheckResult = { ok: boolean; ip: string | null; checkedAt: string; latencyMs: number; error: string | null };
