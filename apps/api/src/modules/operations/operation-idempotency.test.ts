import { describe, expect, it } from "vitest";
import { sameDnsOperationRequest, type DnsOperationStepIdentity } from "./operation-idempotency.js";

const expected: DnsOperationStepIdentity = {
  providerAccountId: "account-1",
  zoneId: "zone-1",
  action: "create",
  input: {
    zoneExternalId: "remote-zone-1",
    record: { type: "A", name: "api.example.com", content: "192.0.2.10", ttl: 60, providerMetadata: {} },
  },
};

describe("DNS Operation idempotency identity", () => {
  it("accepts an exact replay after a create step has acquired a local record ID", () => {
    expect(sameDnsOperationRequest({ ...expected, dnsRecordId: "record-created-later" }, expected)).toBe(true);
  });

  it("rejects reuse for different content, action, or provider account", () => {
    expect(sameDnsOperationRequest({ ...expected, input: { ...expected.input as object, changed: true } }, expected)).toBe(false);
    expect(sameDnsOperationRequest({ ...expected, action: "delete" }, expected)).toBe(false);
    expect(sameDnsOperationRequest({ ...expected, providerAccountId: "account-2" }, expected)).toBe(false);
  });

  it("includes the original record ID for update and delete requests", () => {
    const update = { ...expected, action: "update" as const, dnsRecordId: "record-1" };
    expect(sameDnsOperationRequest(update, update)).toBe(true);
    expect(sameDnsOperationRequest({ ...update, dnsRecordId: "record-2" }, update)).toBe(false);
  });
});
