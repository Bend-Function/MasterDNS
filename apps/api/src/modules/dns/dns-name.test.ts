import type { DnsRecordInput } from "@masterdns/contracts";
import { describe, expect, it } from "vitest";
import { normalizeRecordName } from "./dns-name.js";

const record: DnsRecordInput = {
  type: "A",
  name: "api",
  content: "192.0.2.10",
  ttl: 60,
  providerMetadata: { proxied: false },
};

describe("DNS record name ownership", () => {
  it("expands relative names and preserves record attributes", () => {
    expect(normalizeRecordName(record, "Example.COM.")).toEqual({
      ...record,
      name: "api.example.com",
    });
    expect(record.name).toBe("api");
  });

  it("normalizes root and fully-qualified names", () => {
    expect(normalizeRecordName({ ...record, name: "@" }, "example.com").name).toBe("example.com");
    expect(normalizeRecordName({ ...record, name: "API.Example.COM." }, "example.com").name).toBe("api.example.com");
  });

  it("rejects a name outside the selected zone", () => {
    expect(() => normalizeRecordName({ ...record, name: "api.example.net" }, "example.com")).toThrow(/不属于当前域名/);
    expect(() => normalizeRecordName({ ...record, name: "example.com.attacker.test" }, "example.com")).toThrow(/不属于当前域名/);
  });
});
