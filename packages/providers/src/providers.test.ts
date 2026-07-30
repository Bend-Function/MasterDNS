import type { DnsRecordInput } from "@masterdns/contracts";
import { describe, expect, it, vi } from "vitest";
import { AliyunDnsAdapter, mapAliyunError, normalizeAliyunRecord } from "./aliyun.js";
import { CloudflareDnsAdapter, mapCloudflareError, normalizeCloudflareRecord } from "./cloudflare.js";
import { providerRecordHash } from "./record-hash.js";
import { dnsRecordMatches } from "./record-match.js";

const recordInput: DnsRecordInput = {
  type: "A",
  name: "www.example.com",
  content: "192.0.2.1",
  ttl: 300,
  providerMetadata: {},
};

function createAliyunClient() {
  return {
    describeDomains: vi.fn(),
    describeDomainRecords: vi.fn(),
    describeDomainRecordInfo: vi.fn(),
    addDomainRecord: vi.fn(),
    updateDomainRecord: vi.fn(),
    updateDNSSLBWeight: vi.fn(),
    setDomainRecordStatus: vi.fn(),
    deleteDomainRecord: vi.fn(),
  };
}

describe("provider normalization", () => {
  it("preserves Cloudflare proxy metadata", () => {
    const record = normalizeCloudflareRecord({ id: "r1", name: "www.example.com", type: "A", content: "192.0.2.1", ttl: 1, proxied: true }, "z1");
    expect(record.providerMetadata.proxied).toBe(true);
    expect(record.content).toBe("192.0.2.1");
  });

  it("normalizes Aliyun root and line fields", () => {
    const record = normalizeAliyunRecord({ recordId: "r1", RR: "@", type: "A", value: "192.0.2.1", TTL: 600, line: "default", status: "ENABLE" }, "example.com");
    expect(record.name).toBe("example.com");
    expect(record.providerMetadata.line).toBe("default");
    expect(record.providerMetadata.status).toBe("Enable");
    expect(dnsRecordMatches(record, {
      type: "A",
      name: "example.com",
      content: "192.0.2.1",
      ttl: 600,
      providerMetadata: { line: "default", status: "enabled" },
    })).toBe(true);
    expect(providerRecordHash(record)).toBe(providerRecordHash({
      ...record,
      providerMetadata: { ...record.providerMetadata, status: "ENABLE" },
    }));
  });

  it("uses Cloudflare's automatic TTL when proxying a record", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "r1",
      name: recordInput.name,
      type: recordInput.type,
      content: recordInput.content,
      ttl: 1,
      proxied: true,
    });
    const client = { dns: { records: { create } } };
    const adapter = new CloudflareDnsAdapter("test-token", client as never);

    const created = await adapter.createRecord("z1", {
      ...recordInput,
      providerMetadata: { proxied: true },
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ ttl: 1, proxied: true }), { maxRetries: 0 });
    expect(dnsRecordMatches(created, { ...recordInput, providerMetadata: { proxied: true } })).toBe(true);
  });
});

describe("Aliyun metadata writes", () => {
  it("rejects invalid metadata before creating the base record", async () => {
    const client = createAliyunClient();
    const adapter = new AliyunDnsAdapter({ accessKeyId: "key", accessKeySecret: "secret" }, client as never);

    await expect(adapter.createRecord("example.com", {
      ...recordInput,
      providerMetadata: { weight: 0 },
    })).rejects.toMatchObject({ code: "validation_failed" });
    expect(client.addDomainRecord).not.toHaveBeenCalled();
  });

  it("rejects a non-string status before updating the base record", async () => {
    const client = createAliyunClient();
    const adapter = new AliyunDnsAdapter({ accessKeyId: "key", accessKeySecret: "secret" }, client as never);

    await expect(adapter.updateRecord("example.com", "r1", {
      ...recordInput,
      providerMetadata: { status: true },
    })).rejects.toMatchObject({ code: "validation_failed" });
    expect(client.describeDomainRecordInfo).not.toHaveBeenCalled();
    expect(client.updateDomainRecord).not.toHaveBeenCalled();
  });

  it("removes a newly created record when a metadata write fails", async () => {
    const client = createAliyunClient();
    client.addDomainRecord.mockResolvedValue({ body: { recordId: "r1" } });
    client.setDomainRecordStatus.mockRejectedValue({ statusCode: 403 });
    client.deleteDomainRecord.mockResolvedValue({});
    const adapter = new AliyunDnsAdapter({ accessKeyId: "key", accessKeySecret: "secret" }, client as never);

    await expect(adapter.createRecord("example.com", {
      ...recordInput,
      providerMetadata: { status: "disabled" },
    })).rejects.toMatchObject({ code: "permission_denied" });
    expect(client.setDomainRecordStatus).toHaveBeenCalledWith(expect.objectContaining({ recordId: "r1", status: "Disable" }));
    expect(client.deleteDomainRecord).toHaveBeenCalledWith(expect.objectContaining({ recordId: "r1" }));
  });

  it("reports a non-retryable partial create when compensation also fails", async () => {
    const client = createAliyunClient();
    client.addDomainRecord.mockResolvedValue({ body: { recordId: "r1" } });
    client.setDomainRecordStatus.mockRejectedValue({ statusCode: 500 });
    client.deleteDomainRecord.mockRejectedValue({ statusCode: 500 });
    const adapter = new AliyunDnsAdapter({ accessKeyId: "key", accessKeySecret: "secret" }, client as never);

    await expect(adapter.createRecord("example.com", {
      ...recordInput,
      providerMetadata: { status: "Disable" },
    })).rejects.toMatchObject({ code: "unknown_provider_error", retryable: false });
    expect(client.addDomainRecord).toHaveBeenCalledOnce();
  });

  it("restores only metadata fields changed before a later metadata failure", async () => {
    const client = createAliyunClient();
    client.describeDomainRecordInfo.mockResolvedValue({ body: {
      recordId: "r1",
      domainName: "example.com",
      RR: "www",
      type: "A",
      value: "192.0.2.10",
      TTL: 600,
      line: "default",
      weight: 10,
      status: "ENABLE",
    } });
    client.updateDomainRecord.mockResolvedValue({});
    client.setDomainRecordStatus.mockResolvedValue({});
    client.updateDNSSLBWeight.mockRejectedValue({ statusCode: 500 });
    const adapter = new AliyunDnsAdapter({ accessKeyId: "key", accessKeySecret: "secret" }, client as never);

    await expect(adapter.updateRecord("example.com", "r1", {
      ...recordInput,
      providerMetadata: { line: "telecom", status: "Disable", weight: 20 },
    })).rejects.toMatchObject({ code: "transient_failure" });

    expect(client.updateDomainRecord).toHaveBeenCalledTimes(2);
    expect(client.updateDomainRecord.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ value: "192.0.2.1", line: "telecom" }));
    expect(client.updateDomainRecord.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ value: "192.0.2.10", line: "default" }));
    expect(client.setDomainRecordStatus).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: "Enable" }));
    expect(client.updateDNSSLBWeight).toHaveBeenCalledTimes(1);
    expect(client.updateDNSSLBWeight).toHaveBeenCalledWith(expect.objectContaining({ weight: 20 }));
  });

  it("does not replay a status call that failed and preserves its error classification", async () => {
    const client = createAliyunClient();
    client.describeDomainRecordInfo.mockResolvedValue({ body: {
      recordId: "r1",
      domainName: "example.com",
      RR: "www",
      type: "A",
      value: "192.0.2.10",
      TTL: 600,
      line: "default",
      weight: 10,
      status: "ENABLE",
    } });
    client.updateDomainRecord.mockResolvedValue({});
    client.setDomainRecordStatus.mockRejectedValue({ statusCode: 403 });
    const adapter = new AliyunDnsAdapter({ accessKeyId: "key", accessKeySecret: "secret" }, client as never);

    await expect(adapter.updateRecord("example.com", "r1", {
      ...recordInput,
      providerMetadata: { line: "telecom", status: "Disable", weight: 20 },
    })).rejects.toMatchObject({ code: "permission_denied", retryable: false });

    expect(client.updateDomainRecord).toHaveBeenCalledTimes(2);
    expect(client.setDomainRecordStatus).toHaveBeenCalledTimes(1);
    expect(client.updateDNSSLBWeight).not.toHaveBeenCalled();
  });
});

describe("provider errors", () => {
  it("classifies Aliyun throttling as retryable", () => {
    const error = mapAliyunError({ code: "Throttling.User", statusCode: 429 });
    expect(error.code).toBe("rate_limited");
    expect(error.retryable).toBe(true);
  });

  it("redacts unknown Cloudflare error details", () => {
    const error = mapCloudflareError(new Error("contains-secret-value"));
    expect(error.message).not.toContain("contains-secret-value");
    expect(error.code).toBe("unknown_provider_error");
  });
});
