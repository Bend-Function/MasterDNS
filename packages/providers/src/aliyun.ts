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
  SetDomainRecordStatusRequest,
  type SetDomainRecordStatusResponse,
  UpdateDomainRecordRequest,
  type UpdateDomainRecordResponse,
  UpdateDNSSLBWeightRequest,
  type UpdateDNSSLBWeightResponse,
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
  updateDNSSLBWeight(request: UpdateDNSSLBWeightRequest): Promise<UpdateDNSSLBWeightResponse>;
  setDomainRecordStatus(request: SetDomainRecordStatusRequest): Promise<SetDomainRecordStatusResponse>;
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
      const metadata = validateAliyunMetadata(input.providerMetadata);
      const response = await this.client.addDomainRecord(new AddDomainRecordRequest(toAliyunInput(zoneExternalId, input)));
      const recordId = response.body?.recordId;
      if (!recordId) throw new ProviderError("Aliyun did not return the created record ID", "unknown_provider_error", this.provider);
      try {
        await this.applyMetadata(recordId, metadata);
      } catch (error) {
        try {
          await this.client.deleteDomainRecord(new DeleteDomainRecordRequest({ recordId }));
        } catch (cleanupError) {
          throw new ProviderError(`Aliyun DNS record ${recordId} was partially created and cleanup failed`, "unknown_provider_error", this.provider, {
            retryable: false,
            cause: new AggregateError([error, cleanupError]),
          });
        }
        throw error;
      }
      return (await this.getRecord(zoneExternalId, recordId)) ?? recordFromInput(recordId, zoneExternalId, input);
    });
  }

  async updateRecord(zoneExternalId: string, recordExternalId: string, input: DnsRecordInput): Promise<ProviderRecord> {
    return this.wrap(async () => {
      const metadata = validateAliyunMetadata(input.providerMetadata);
      const before = await this.getRecord(zoneExternalId, recordExternalId);
      await this.client.updateDomainRecord(new UpdateDomainRecordRequest({ recordId: recordExternalId, ...toAliyunInput(zoneExternalId, input) }));
      const appliedMetadata = new Set<keyof AliyunWriteMetadata>();
      try {
        await this.applyMetadata(recordExternalId, metadata, before ?? undefined, appliedMetadata);
      } catch (error) {
        if (before) {
          try {
            await this.client.updateDomainRecord(new UpdateDomainRecordRequest({
              recordId: recordExternalId,
              ...toAliyunInput(zoneExternalId, before),
            }));
            await this.restoreAppliedMetadata(recordExternalId, before, appliedMetadata);
          } catch (rollbackError) {
            throw new ProviderError(`Aliyun DNS record ${recordExternalId} was partially updated and rollback failed`, "unknown_provider_error", this.provider, {
              retryable: false,
              cause: new AggregateError([error, rollbackError]),
            });
          }
        }
        throw error;
      }
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

  private async applyMetadata(
    recordId: string,
    metadata: AliyunWriteMetadata,
    before?: ProviderRecord,
    applied?: Set<keyof AliyunWriteMetadata>,
  ) {
    const requestedStatus = metadata.status;
    const previousStatus = normalizeAliyunStatus(before?.providerMetadata.status);
    if (requestedStatus && requestedStatus !== previousStatus) {
      await this.client.setDomainRecordStatus(new SetDomainRecordStatusRequest({ recordId, status: requestedStatus }));
      applied?.add("status");
    }
    const requestedWeight = metadata.weight;
    if (requestedWeight !== undefined && requestedWeight !== before?.providerMetadata.weight) {
      await this.client.updateDNSSLBWeight(new UpdateDNSSLBWeightRequest({ recordId, weight: requestedWeight }));
      applied?.add("weight");
    }
  }

  private async restoreAppliedMetadata(
    recordId: string,
    before: ProviderRecord,
    applied: ReadonlySet<keyof AliyunWriteMetadata>,
  ) {
    const previous = validateAliyunMetadata(before.providerMetadata);
    if (applied.has("weight")) {
      if (previous.weight === undefined) throw new Error("Previous Aliyun DNS weight is unavailable for rollback");
      await this.client.updateDNSSLBWeight(new UpdateDNSSLBWeightRequest({ recordId, weight: previous.weight }));
    }
    if (applied.has("status")) {
      if (previous.status === undefined) throw new Error("Previous Aliyun DNS status is unavailable for rollback");
      await this.client.setDomainRecordStatus(new SetDomainRecordStatusRequest({ recordId, status: previous.status }));
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
  if (record.status !== undefined) providerMetadata.status = normalizeAliyunStatus(record.status);
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

type AliyunRecordInput = {
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number | null | undefined;
  providerMetadata: Record<string, unknown>;
};

function toAliyunInput(zoneExternalId: string, input: AliyunRecordInput): Record<string, unknown> {
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
  const providerMetadata = { ...input.providerMetadata };
  if (providerMetadata.status !== undefined) providerMetadata.status = normalizeAliyunStatus(providerMetadata.status);
  return { externalId: recordId, zoneExternalId, ...input, providerMetadata };
}

function normalizeAliyunStatus(value: unknown): "Enable" | "Disable" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "enable" || normalized === "enabled") return "Enable";
  if (normalized === "disable" || normalized === "disabled") return "Disable";
  throw new ProviderError("Aliyun DNS status must be Enable or Disable", "validation_failed", "aliyun");
}

type AliyunWriteMetadata = {
  weight?: number;
  status?: "Enable" | "Disable";
};

function validateAliyunMetadata(metadata: Record<string, unknown>): AliyunWriteMetadata {
  if (metadata.line !== undefined && typeof metadata.line !== "string") {
    throw new ProviderError("Aliyun DNS line must be a string", "validation_failed", "aliyun");
  }
  const result: AliyunWriteMetadata = {};
  if (metadata.weight !== undefined) {
    if (typeof metadata.weight !== "number" || !Number.isInteger(metadata.weight) || metadata.weight < 1 || metadata.weight > 100) {
      throw new ProviderError("Aliyun DNS weight must be an integer from 1 to 100", "validation_failed", "aliyun");
    }
    result.weight = metadata.weight;
  }
  if (metadata.status !== undefined) {
    if (typeof metadata.status !== "string") {
      throw new ProviderError("Aliyun DNS status must be Enable or Disable", "validation_failed", "aliyun");
    }
    const status = normalizeAliyunStatus(metadata.status);
    if (status !== undefined) result.status = status;
  }
  return result;
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
