import { z } from "zod";

// Keep this contract browser-safe so the form and API use the same IDN rules.
export const zoneNameSchema = z.string().trim().min(1).max(253).transform((value, context) => {
  let name = "";
  const input = value.replace(/\.$/, "");
  if (!/[\s/:@?#\\%]/u.test(input)) {
    try { name = new URL(`http://${input}`).hostname.toLowerCase(); } catch { /* Report the common validation error below. */ }
  }
  const labels = name.split(".");
  if (!name || name.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+$/.test(labels.at(-1)!)) {
    context.addIssue({ code: "custom", message: "请输入有效域名，例如 example.com；不要包含协议、路径、端口或通配符" });
    return z.NEVER;
  }
  return name;
});

const accountFields = {
  providerAccountId: z.string().uuid(),
  cloudflareAccountId: z.string().trim().regex(/^[a-f0-9]{32}$/i, "Cloudflare Account ID 必须是 32 位十六进制字符").transform(value => value.toLowerCase()),
};

export const createZoneInputSchema = z.object({ ...accountFields, name: zoneNameSchema });
export const createZonesInputSchema = z.object({
  ...accountFields,
  names: z.array(zoneNameSchema).min(1, "请至少输入一个域名").max(100, "每次最多添加 100 个域名").transform(names => [...new Set(names)]),
});
export type CreateZoneInput = z.infer<typeof createZoneInputSchema>;
export type CreateZonesInput = z.infer<typeof createZonesInputSchema>;
export type ProviderZoneInput = { name: string; accountId: string };

export type ZoneCreationSuccess = {
  name: string;
  status: "created" | "existing";
  zoneId: string;
  zoneStatus: "active" | "pending" | "error";
  nameServers: string[];
};
export type ZoneCreationResult = ZoneCreationSuccess | {
  name: string;
  status: "failed";
  error: { code: string; message: string };
};
