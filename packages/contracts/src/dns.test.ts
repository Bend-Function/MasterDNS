import { describe, expect, it } from "vitest";
import { dnsRecordInputSchema } from "./dns.js";

describe("dnsRecordInputSchema", () => {
  it("accepts valid IPv4 and IPv6 address records", () => {
    expect(dnsRecordInputSchema.parse({ type: "A", name: "a.example.com", content: "192.0.2.10", ttl: 60 })).toMatchObject({ type: "A" });
    expect(dnsRecordInputSchema.parse({ type: "AAAA", name: "a.example.com", content: "2001:db8::10", ttl: 60 })).toMatchObject({ type: "AAAA" });
  });

  it("rejects malformed or wrong-family address records before a provider call", () => {
    expect(() => dnsRecordInputSchema.parse({ type: "A", name: "a.example.com", content: "999.2.3.4", ttl: 60 })).toThrow(/IPv4/);
    expect(() => dnsRecordInputSchema.parse({ type: "AAAA", name: "a.example.com", content: "192.0.2.10", ttl: 60 })).toThrow(/IPv6/);
  });

  it("requires priority for MX and SRV records", () => {
    expect(() => dnsRecordInputSchema.parse({ type: "MX", name: "example.com", content: "mail.example.com", ttl: 300 })).toThrow(/优先级/);
    expect(dnsRecordInputSchema.parse({ type: "MX", name: "example.com", content: "mail.example.com", ttl: 300, priority: 10 })).toMatchObject({ priority: 10 });
  });
});
