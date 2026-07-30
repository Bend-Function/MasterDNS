import type {
  CredentialCapabilities,
  DnsRecordInput,
  Page,
  ProviderRecord,
  ProviderType,
  ProviderZone,
} from "@masterdns/contracts";

export type CloudflareCredentials = { provider: "cloudflare"; apiToken: string };
export type AliyunCredentials = { provider: "aliyun"; accessKeyId: string; accessKeySecret: string; regionId?: string };
export type ProviderCredentials = CloudflareCredentials | AliyunCredentials;

export interface DnsProviderAdapter {
  readonly provider: ProviderType;
  verifyCredentials(): Promise<CredentialCapabilities>;
  listZones(cursor?: string): Promise<Page<ProviderZone>>;
  listRecords(zoneExternalId: string, cursor?: string): Promise<Page<ProviderRecord>>;
  getRecord(zoneExternalId: string, recordExternalId: string): Promise<ProviderRecord | null>;
  createRecord(zoneExternalId: string, input: DnsRecordInput): Promise<ProviderRecord>;
  updateRecord(zoneExternalId: string, recordExternalId: string, input: DnsRecordInput): Promise<ProviderRecord>;
  deleteRecord(zoneExternalId: string, recordExternalId: string): Promise<void>;
}
