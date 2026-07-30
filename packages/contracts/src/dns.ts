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
