import Cloudflare from "cloudflare";
import type {
  CredentialCapabilities,
  DnsRecordInput,
  Page,
  ProviderRecord,
  ProviderZone,
} from "@masterdns/contracts";
import { ProviderError } from "@masterdns/contracts";
import type { DnsProviderAdapter } from "./provider.js";

type CloudflareRecordShape = {
  id: string;
  name: string;
  type: string;
  content?: string;
  data?: unknown;
  ttl: number;
  priority?: number;
  proxied?: boolean;
  proxiable?: boolean;
  comment?: string;
  tags?: string[];
  modified_on?: string;
};

const PAGE_SIZE = 100;

export class CloudflareDnsAdapter implements DnsProviderAdapter {
  readonly provider = "cloudflare" as const;
  private readonly client: Cloudflare;

  constructor(apiToken: string, client?: Cloudflare) {
    this.client = client ?? new Cloudflare({ apiToken, timeout: 10_000, maxRetries: 2, logLevel: "off" });
  }

  async verifyCredentials(): Promise<CredentialCapabilities> {
    return this.wrap(async () => {
      const token = await this.client.user.tokens.verify();
      if (token.status !== "active") throw new ProviderError(`Cloudflare token is ${token.status}`, "authentication_failed", this.provider);
      await this.client.zones.list({ page: 1, per_page: 1 });
      return { canReadZones: true, canReadRecords: true, canWriteRecords: true };
    });
  }

  async listZones(cursor?: string): Promise<Page<ProviderZone>> {
    return this.wrap(async () => {
      const pageNumber = parseCursor(cursor);
      const page = await this.client.zones.list({ page: pageNumber, per_page: PAGE_SIZE, order: "name", direction: "asc" });
      const items = page.result.map((zone) => ({
        externalId: zone.id,
        name: zone.name,
        status: zone.status === "active" ? "active" as const : "pending" as const,
        providerMetadata: { accountId: zone.account.id, accountName: zone.account.name, type: zone.type, nameServers: zone.name_servers },
      }));
      return { items, ...(page.hasNextPage() ? { nextCursor: String(pageNumber + 1) } : {}) };
    });
  }

  async listRecords(zoneExternalId: string, cursor?: string): Promise<Page<ProviderRecord>> {
    return this.wrap(async () => {
      const pageNumber = parseCursor(cursor);
      const page = await this.client.dns.records.list({ zone_id: zoneExternalId, page: pageNumber, per_page: PAGE_SIZE });
      return {
        items: page.result.map((record) => normalizeCloudflareRecord(record as CloudflareRecordShape, zoneExternalId)),
        ...(page.hasNextPage() ? { nextCursor: String(pageNumber + 1) } : {}),
      };
    });
  }

  async getRecord(zoneExternalId: string, recordExternalId: string): Promise<ProviderRecord | null> {
    try {
      const record = await this.client.dns.records.get(recordExternalId, { zone_id: zoneExternalId });
      return normalizeCloudflareRecord(record as CloudflareRecordShape, zoneExternalId);
    } catch (error) {
      const mapped = mapCloudflareError(error);
      if (mapped.code === "not_found") return null;
      throw mapped;
    }
  }

  async createRecord(zoneExternalId: string, input: DnsRecordInput): Promise<ProviderRecord> {
    return this.wrap(async () => {
      const record = await this.client.dns.records.create(toCloudflareCreateInput(zoneExternalId, input));
      return normalizeCloudflareRecord(record as CloudflareRecordShape, zoneExternalId);
    });
  }

  async updateRecord(zoneExternalId: string, recordExternalId: string, input: DnsRecordInput): Promise<ProviderRecord> {
    return this.wrap(async () => {
      const record = await this.client.dns.records.update(recordExternalId, toCloudflareUpdateInput(zoneExternalId, input));
      return normalizeCloudflareRecord(record as CloudflareRecordShape, zoneExternalId);
    });
  }

  async deleteRecord(zoneExternalId: string, recordExternalId: string): Promise<void> {
    await this.wrap(async () => { await this.client.dns.records.delete(recordExternalId, { zone_id: zoneExternalId }); });
  }

  private async wrap<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw mapCloudflareError(error);
    }
  }
}

export function normalizeCloudflareRecord(record: CloudflareRecordShape, zoneExternalId: string): ProviderRecord {
  const providerMetadata: Record<string, unknown> = {};
  if (record.proxied !== undefined) providerMetadata.proxied = record.proxied;
  if (record.proxiable !== undefined) providerMetadata.proxiable = record.proxiable;
  if (record.comment !== undefined) providerMetadata.comment = record.comment;
  if (record.tags !== undefined) providerMetadata.tags = record.tags;
  return {
    externalId: record.id,
    zoneExternalId,
    type: record.type,
    name: record.name,
    content: record.content ?? JSON.stringify(record.data ?? {}),
    ttl: record.ttl,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
    providerMetadata,
    ...(record.modified_on ? { modifiedAt: new Date(record.modified_on) } : {}),
  };
}

function toCloudflareCreateInput(zoneId: string, input: DnsRecordInput): Parameters<Cloudflare["dns"]["records"]["create"]>[0] {
  return toCloudflareInput(zoneId, input) as unknown as Parameters<Cloudflare["dns"]["records"]["create"]>[0];
}

function toCloudflareUpdateInput(zoneId: string, input: DnsRecordInput): Parameters<Cloudflare["dns"]["records"]["update"]>[1] {
  return toCloudflareInput(zoneId, input) as unknown as Parameters<Cloudflare["dns"]["records"]["update"]>[1];
}

function toCloudflareInput(zoneId: string, input: DnsRecordInput): Record<string, unknown> {
  const metadata = input.providerMetadata;
  return {
    zone_id: zoneId,
    type: input.type,
    name: input.name,
    content: input.content,
    ttl: input.ttl,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(typeof metadata.proxied === "boolean" ? { proxied: metadata.proxied } : {}),
    ...(typeof metadata.comment === "string" ? { comment: metadata.comment } : {}),
    ...(Array.isArray(metadata.tags) ? { tags: metadata.tags.filter((tag): tag is string => typeof tag === "string") } : {}),
  };
}

function parseCursor(cursor?: string): number {
  const parsed = cursor === undefined ? 1 : Number.parseInt(cursor, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ProviderError("Invalid pagination cursor", "validation_failed", "cloudflare");
  return parsed;
}

export function mapCloudflareError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Cloudflare.APIError) {
    const status = error.status;
    const retryAfterSeconds = Number.parseInt(error.headers?.get("retry-after") ?? "", 10);
    if (status === 401) return new ProviderError("Cloudflare authentication failed", "authentication_failed", "cloudflare", { cause: error });
    if (status === 403) return new ProviderError("Cloudflare permission denied", "permission_denied", "cloudflare", { cause: error });
    if (status === 404) return new ProviderError("Cloudflare resource not found", "not_found", "cloudflare", { cause: error });
    if (status === 409) return new ProviderError("Cloudflare record conflict", "conflict", "cloudflare", { cause: error });
    if (status === 400 || status === 422) return new ProviderError("Cloudflare rejected the DNS record", "validation_failed", "cloudflare", { cause: error });
    if (status === 429) return new ProviderError("Cloudflare API rate limit exceeded", "rate_limited", "cloudflare", {
      cause: error,
      ...(Number.isFinite(retryAfterSeconds) ? { retryAfterMs: retryAfterSeconds * 1000 } : {}),
    });
    if (status === undefined || status >= 500) return new ProviderError("Cloudflare API is temporarily unavailable", "transient_failure", "cloudflare", { cause: error });
  }
  return new ProviderError("Unexpected Cloudflare API error", "unknown_provider_error", "cloudflare", { cause: error });
}
