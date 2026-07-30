import type { DnsRecordInput, ProviderRecord } from "@masterdns/contracts";
import { describe, expect, it } from "vitest";
import { recordMatches } from "./operation.processor.js";

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
    expect(recordMatches(remote, expected)).toBe(true);
  });

  it("rejects a remote content mismatch", () => {
    expect(recordMatches({ ...remote, content: "192.0.2.11" }, expected)).toBe(false);
  });

  it("rejects a requested provider field mismatch", () => {
    expect(recordMatches({ ...remote, providerMetadata: { proxied: true } }, expected)).toBe(false);
  });
});
