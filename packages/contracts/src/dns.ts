import { isIP } from "node:net";
import { z } from "zod";

export const providerTypeSchema = z.enum(["cloudflare", "aliyun"]);
export type ProviderType = z.infer<typeof providerTypeSchema>;

export const dnsRecordTypeSchema = z.enum([
  "A",
  "AAAA",
  "CAA",
  "CNAME",
  "MX",
  "NS",
  "SRV",
  "TXT",
]);
export type DnsRecordType = z.infer<typeof dnsRecordTypeSchema>;

export const dnsRecordInputSchema = z.object({
  type: dnsRecordTypeSchema,
  name: z.string().trim().min(1).max(255),
  content: z.string().trim().min(1).max(4096),
  ttl: z.number().int().min(1).max(86400),
  priority: z.number().int().min(0).max(65535).optional(),
  providerMetadata: z.record(z.string(), z.unknown()).default({}),
}).superRefine((record, context) => {
  if (record.type === "A" && isIP(record.content) !== 4) {
    context.addIssue({ code: "custom", path: ["content"], message: "A 记录内容必须是有效的 IPv4 地址" });
  }
  if (record.type === "AAAA" && isIP(record.content) !== 6) {
    context.addIssue({ code: "custom", path: ["content"], message: "AAAA 记录内容必须是有效的 IPv6 地址" });
  }
  if (["MX", "SRV"].includes(record.type) && record.priority === undefined) {
    context.addIssue({ code: "custom", path: ["priority"], message: `${record.type} 记录必须提供优先级` });
  }
});
export type DnsRecordInput = z.infer<typeof dnsRecordInputSchema>;

export type ProviderZone = {
  externalId: string;
  name: string;
  status: "active" | "pending" | "error";
  providerMetadata: Record<string, unknown>;
};

export type ProviderRecord = Omit<DnsRecordInput, "type"> & {
  type: string;
  externalId: string;
  zoneExternalId: string;
  modifiedAt?: Date;
};

export type Page<T> = {
  items: T[];
  nextCursor?: string;
};

export type CredentialCapabilities = {
  canReadZones: boolean;
  canReadRecords: boolean;
  canWriteRecords: boolean;
  accountLabel?: string;
};
