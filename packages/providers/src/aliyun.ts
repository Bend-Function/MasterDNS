import { createRequire } from "node:module";
import {
  AddDomainRecordRequest,
  type AddDomainRecordResponse,
  DeleteDomainRecordRequest,
  type DeleteDomainRecordResponse,
  DescribeDomainRecordInfoRequest,
  type DescribeDomainRecordInfoResponse,
  DescribeDomainRecordsRequest,
  type DescribeDomainRecordsResponse,
  DescribeDomainsRequest,
  type DescribeDomainsResponse,
  UpdateDomainRecordRequest,
  type UpdateDomainRecordResponse,
} from "@alicloud/alidns20150109";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import type {
  CredentialCapabilities,
  DnsRecordInput,
  Page,
  ProviderRecord,
  ProviderZone,
} from "@masterdns/contracts";
import { ProviderError } from "@masterdns/contracts";
import type { AliyunCredentials, DnsProviderAdapter } from "./provider.js";

type AliyunRecordShape = {
  recordId?: string;
  domainName?: string;
  RR?: string;
  type?: string;
  value?: string;
  TTL?: number;
  priority?: number;
  line?: string;
  weight?: number;
  status?: string;
  locked?: boolean;
  remark?: string;
  updateTimestamp?: number;
};

const PAGE_SIZE = 100;

type AliDnsClient = {
  describeDomains(request: DescribeDomainsRequest): Promise<DescribeDomainsResponse>;
  describeDomainRecords(request: DescribeDomainRecordsRequest): Promise<DescribeDomainRecordsResponse>;
  describeDomainRecordInfo(request: DescribeDomainRecordInfoRequest): Promise<DescribeDomainRecordInfoResponse>;
  addDomainRecord(request: AddDomainRecordRequest): Promise<AddDomainRecordResponse>;
  updateDomainRecord(request: UpdateDomainRecordRequest): Promise<UpdateDomainRecordResponse>;
  deleteDomainRecord(request: DeleteDomainRecordRequest): Promise<DeleteDomainRecordResponse>;
};

type AliDnsConstructor = new (config: $OpenApiUtil.Config) => AliDnsClient;
const require = createRequire(import.meta.url);
const AliDnsClient = (require("@alicloud/alidns20150109") as { default: AliDnsConstructor }).default;

export class AliyunDnsAdapter implements DnsProviderAdapter {
  readonly provider = "aliyun" as const;
  private readonly client: AliDnsClient;

  constructor(credentials: Omit<AliyunCredentials, "provider"> | AliyunCredentials, client?: AliDnsClient) {
    this.client = client ?? new AliDnsClient(new $OpenApiUtil.Config({
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      regionId: credentials.regionId ?? "cn-hangzhou",
      endpoint: "alidns.aliyuncs.com",
      connectTimeout: 5000,
      readTimeout: 10_000,
      userAgent: "MasterDNS/0.1",
    }));
  }

  async verifyCredentials(): Promise<CredentialCapabilities> {
    return this.wrap(async () => {
      await this.client.describeDomains(new DescribeDomainsRequest({ pageNumber: 1, pageSize: 1 }));
      return { canReadZones: true, canReadRecords: true, canWriteRecords: true };
    });
  }

  async listZones(cursor?: string): Promise<Page<ProviderZone>> {
    return this.wrap(async () => {
      const pageNumber = parseCursor(cursor);
      const response = await this.client.describeDomains(new DescribeDomainsRequest({ pageNumber, pageSize: PAGE_SIZE }));
      const body = response.body;
      const domains = body?.domains?.domain ?? [];
      const items = domains.flatMap((domain): ProviderZone[] => {
        if (!domain.domainName) return [];
        return [{
          externalId: domain.domainName,
          name: domain.punyCode || domain.domainName,
          status: domain.instanceExpired ? "error" : "active",
          providerMetadata: {
            domainId: domain.domainId,
            groupId: domain.groupId,
            groupName: domain.groupName,
            versionCode: domain.versionCode,
            recordCount: domain.recordCount,
          },
        }];
      });
      const total = body?.totalCount ?? items.length;
      return { items, ...(pageNumber * PAGE_SIZE < total ? { nextCursor: String(pageNumber + 1) } : {}) };
    });
  }

  async listRecords(zoneExternalId: string, cursor?: string): Promise<Page<ProviderRecord>> {
    return this.wrap(async () => {
      const pageNumber = parseCursor(cursor);
      const response = await this.client.describeDomainRecords(new DescribeDomainRecordsRequest({
        domainName: zoneExternalId,
        pageNumber,
        pageSize: PAGE_SIZE,
      }));
      const body = response.body;
      const records = body?.domainRecords?.record ?? [];
      const items = records.flatMap((record): ProviderRecord[] => record.recordId && record.type && record.value
        ? [normalizeAliyunRecord(record, zoneExternalId)]
        : []);
      const total = body?.totalCount ?? items.length;
      return { items, ...(pageNumber * PAGE_SIZE < total ? { nextCursor: String(pageNumber + 1) } : {}) };
    });
  }

  async getRecord(zoneExternalId: string, recordExternalId: string): Promise<ProviderRecord | null> {
    try {
      const response = await this.client.describeDomainRecordInfo(new DescribeDomainRecordInfoRequest({ recordId: recordExternalId }));
      if (!response.body?.recordId) return null;
      return normalizeAliyunRecord(response.body, response.body.domainName ?? zoneExternalId);
    } catch (error) {
      const mapped = mapAliyunError(error);
      if (mapped.code === "not_found") return null;
      throw mapped;
    }
  }

  async createRecord(zoneExternalId: string, input: DnsRecordInput): Promise<ProviderRecord> {
    return this.wrap(async () => {
      const response = await this.client.addDomainRecord(new AddDomainRecordRequest(toAliyunInput(zoneExternalId, input)));
      const recordId = response.body?.recordId;
      if (!recordId) throw new ProviderError("Aliyun did not return the created record ID", "unknown_provider_error", this.provider);
      return (await this.getRecord(zoneExternalId, recordId)) ?? recordFromInput(recordId, zoneExternalId, input);
    });
  }

  async updateRecord(zoneExternalId: string, recordExternalId: string, input: DnsRecordInput): Promise<ProviderRecord> {
    return this.wrap(async () => {
      await this.client.updateDomainRecord(new UpdateDomainRecordRequest({ recordId: recordExternalId, ...toAliyunInput(zoneExternalId, input) }));
      return (await this.getRecord(zoneExternalId, recordExternalId)) ?? recordFromInput(recordExternalId, zoneExternalId, input);
    });
  }

  async deleteRecord(_zoneExternalId: string, recordExternalId: string): Promise<void> {
    await this.wrap(async () => { await this.client.deleteDomainRecord(new DeleteDomainRecordRequest({ recordId: recordExternalId })); });
  }

  private async wrap<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw mapAliyunError(error);
    }
  }
}

export function normalizeAliyunRecord(record: AliyunRecordShape, zoneExternalId: string): ProviderRecord {
  if (!record.recordId || !record.type || record.value === undefined) {
    throw new ProviderError("Aliyun returned an incomplete DNS record", "unknown_provider_error", "aliyun");
  }
  const providerMetadata: Record<string, unknown> = {};
  if (record.line !== undefined) providerMetadata.line = record.line;
  if (record.weight !== undefined) providerMetadata.weight = record.weight;
  if (record.status !== undefined) providerMetadata.status = record.status;
  if (record.locked !== undefined) providerMetadata.locked = record.locked;
  if (record.remark !== undefined) providerMetadata.remark = record.remark;
  return {
    externalId: record.recordId,
    zoneExternalId,
    type: record.type,
    name: fqdnFromRr(record.RR ?? "@", zoneExternalId),
    content: record.value,
    ttl: record.TTL ?? 600,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
    providerMetadata,
    ...(record.updateTimestamp !== undefined ? { modifiedAt: new Date(record.updateTimestamp) } : {}),
  };
}

function toAliyunInput(zoneExternalId: string, input: DnsRecordInput): Record<string, unknown> {
  return {
    domainName: zoneExternalId,
    RR: rrFromFqdn(input.name, zoneExternalId),
    type: input.type,
    value: input.content,
    TTL: input.ttl,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(typeof input.providerMetadata.line === "string" ? { line: input.providerMetadata.line } : {}),
  };
}

function recordFromInput(recordId: string, zoneExternalId: string, input: DnsRecordInput): ProviderRecord {
  return { externalId: recordId, zoneExternalId, ...input };
}

function fqdnFromRr(rr: string, zone: string): string {
  if (rr === "@") return zone;
  return rr.toLowerCase().endsWith(`.${zone.toLowerCase()}`) ? rr : `${rr}.${zone}`;
}

function rrFromFqdn(name: string, zone: string): string {
  const normalizedName = name.replace(/\.$/, "").toLowerCase();
  const normalizedZone = zone.replace(/\.$/, "").toLowerCase();
  if (normalizedName === "@" || normalizedName === normalizedZone) return "@";
  if (!normalizedName.endsWith(`.${normalizedZone}`)) {
    if (!normalizedName.includes(".")) return normalizedName;
    throw new ProviderError("Record name does not belong to the Aliyun zone", "validation_failed", "aliyun");
  }
  return normalizedName.slice(0, -(normalizedZone.length + 1));
}

function parseCursor(cursor?: string): number {
  const parsed = cursor === undefined ? 1 : Number.parseInt(cursor, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ProviderError("Invalid pagination cursor", "validation_failed", "aliyun");
  return parsed;
}

export function mapAliyunError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown; data?: { code?: unknown } };
  const code = String(candidate.code ?? candidate.data?.code ?? "");
  const status = typeof candidate.statusCode === "number" ? candidate.statusCode : undefined;
  const normalized = code.toLowerCase();
  if (status === 401 || normalized.includes("invalidaccesskey") || normalized.includes("signature")) {
    return new ProviderError("Aliyun authentication failed", "authentication_failed", "aliyun", { cause: error });
  }
  if (status === 403 || normalized.includes("forbidden") || normalized.includes("unauthorized")) {
    return new ProviderError("Aliyun permission denied", "permission_denied", "aliyun", { cause: error });
  }
  if (status === 404 || normalized.includes("notfound") || normalized.includes("notbelongtouser")) {
    return new ProviderError("Aliyun DNS resource not found", "not_found", "aliyun", { cause: error });
  }
  if (normalized.includes("duplicate") || normalized.includes("recordexists")) {
    return new ProviderError("Aliyun DNS record already exists", "conflict", "aliyun", { cause: error });
  }
  if (status === 429 || normalized.includes("throttl") || normalized.includes("limitexceeded")) {
    return new ProviderError("Aliyun DNS API rate limit exceeded", "rate_limited", "aliyun", { cause: error });
  }
  if (status !== undefined && status >= 500) {
    return new ProviderError("Aliyun DNS API is temporarily unavailable", "transient_failure", "aliyun", { cause: error });
  }
  if (status === 400 || normalized.startsWith("invalid")) {
    return new ProviderError("Aliyun rejected the DNS record", "validation_failed", "aliyun", { cause: error });
  }
  return new ProviderError("Unexpected Aliyun DNS API error", "unknown_provider_error", "aliyun", { cause: error });
}
