import type { DnsRecordInput, ProviderRecord } from "@masterdns/contracts";
import { dnsRecordMatches } from "@masterdns/providers";
import { describe, expect, it } from "vitest";

const expected: DnsRecordInput = {
  type: "A",
  name: "api.example.com",
  content: "192.0.2.10",
  ttl: 120,
  providerMetadata: { proxied: false },
};

const remote: ProviderRecord = {
  externalId: "record-1",
  zoneExternalId: "zone-1",
  type: "A",
  name: "API.EXAMPLE.COM.",
  content: "192.0.2.10",
  ttl: 120,
  providerMetadata: { proxied: false, proxiable: true },
};

describe("remote DNS verification", () => {
  it("matches normalized names and ignores extra read-only provider metadata", () => {
    expect(dnsRecordMatches(remote, expected)).toBe(true);
  });

  it("rejects a remote content mismatch", () => {
    expect(dnsRecordMatches({ ...remote, content: "192.0.2.11" }, expected)).toBe(false);
  });

  it("rejects a requested provider field mismatch", () => {
    expect(dnsRecordMatches({ ...remote, providerMetadata: { proxied: true } }, expected)).toBe(false);
  });

  it("rejects TTL and record-type drift", () => {
    expect(dnsRecordMatches({ ...remote, ttl: 300 }, expected)).toBe(false);
    expect(dnsRecordMatches({ ...remote, type: "AAAA" }, expected)).toBe(false);
  });
});
