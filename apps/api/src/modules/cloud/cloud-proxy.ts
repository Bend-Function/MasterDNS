import { parseCloudProxyUrl } from "@masterdns/cloud-providers";
import { z } from "zod";

const proxyUrl = z.string().min(1).max(4_096).superRefine((value, context) => {
  try { parseCloudProxyUrl(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid SOCKS proxy URL" }); }
});

export const cloudProxyUpdateSchema = z.object({ proxyUrl: proxyUrl.nullable() }).strict();
export const cloudProxyCheckSchema = z.object({ proxyUrl: proxyUrl.optional() }).strict();

export type CloudProxyUpdateInput = z.infer<typeof cloudProxyUpdateSchema>;
export type CloudProxyCheckInput = z.infer<typeof cloudProxyCheckSchema>;
export type CloudProxyStatus = { configured: boolean; endpoint: string | null };
export type CloudProxyCheckResult = { ok: boolean; ip: string | null; checkedAt: string; latencyMs: number; error: string | null };
