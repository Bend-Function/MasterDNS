import { describe, expect, it } from "vitest";
import { exchangeSchema, heartbeatSchema, installTokenSchema } from "./ddns/ddns.schemas.js";
import { createChannelSchema } from "./notifications/notifications.schemas.js";
import { createBindingSchema, createEndpointSchema, createPoolSchema, updateBindingSchema, updateEndpointSchema } from "./pools/pools.schemas.js";

describe("Pool request schemas", () => {
  it("applies conservative automation defaults", () => {
    expect(createPoolSchema.parse({ name: "edge", strategy: "assignment_pool" })).toMatchObject({
      selectionMode: "ordered",
      recoveryMode: "keep_current",
      failureThreshold: 3,
      successThreshold: 3,
      checkIntervalSeconds: 15,
      checkTimeoutMs: 3000,
      switchCooldownSeconds: 300,
    });
  });

  it("requires a valid address for static endpoints", () => {
    expect(() => createEndpointSchema.parse({ name: "node-a", addressMode: "static" })).toThrow(/至少需要一个 IP/);
    expect(() => createEndpointSchema.parse({ name: "node-a", addressMode: "static", ipv4: "2001:db8::1" })).toThrow(/IPv4/);
    expect(createEndpointSchema.parse({ name: "node-a", addressMode: "static", ipv4: "192.0.2.10" })).toMatchObject({ addressMode: "static", ipv4: "192.0.2.10" });
  });

  it("keeps DDNS endpoint addresses under Agent control", () => {
    expect(createEndpointSchema.parse({ name: "dynamic", addressMode: "ddns" })).toMatchObject({ addressMode: "ddns" });
    expect(() => createEndpointSchema.parse({ name: "dynamic", addressMode: "ddns", ipv4: "192.0.2.10" })).toThrow(/Agent 上报/);
  });

  it("rejects update requests containing only the force flag", () => {
    expect(() => updateEndpointSchema.parse({ forceApply: true })).toThrow(/至少提供/);
    expect(() => updateBindingSchema.parse({ forceApply: true })).toThrow(/至少提供/);
  });

  it("requires an address when explicitly converting an endpoint to static mode", () => {
    expect(() => updateEndpointSchema.parse({ addressMode: "static" })).toThrow(/至少提供一个 IP/);
    expect(() => updateEndpointSchema.parse({ addressMode: "static", ipv4: null, ipv6: null })).toThrow(/至少提供一个 IP/);
    expect(updateEndpointSchema.parse({ addressMode: "static", ipv4: "192.0.2.20" })).toMatchObject({
      addressMode: "static",
      ipv4: "192.0.2.20",
    });
    expect(() => updateEndpointSchema.parse({ addressMode: "ddns", ipv4: "192.0.2.20" })).toThrow();
  });

  it("requires an original endpoint for explicit record takeover", () => {
    const binding = {
      zoneId: "11111111-1111-4111-8111-111111111111",
      fqdn: "api.example.com",
      recordType: "A",
      takeoverExisting: true,
    };
    expect(() => createBindingSchema.parse(binding)).toThrow(/原始节点/);
    expect(createBindingSchema.parse({
      ...binding,
      originalEndpointId: "22222222-2222-4222-8222-222222222222",
    })).toMatchObject({ takeoverExisting: true, ttl: 60 });
  });
});

describe("DDNS request schemas", () => {
  it("validates address families while allowing source-IP inference", () => {
    expect(heartbeatSchema.parse({})).toEqual({});
    expect(heartbeatSchema.parse({ ipv4: "192.0.2.10", ipv6: "2001:db8::10" })).toMatchObject({ ipv4: "192.0.2.10" });
    expect(() => heartbeatSchema.parse({ ipv4: "2001:db8::10" })).toThrow(/IPv4/);
  });

  it("bounds install and exchange credentials", () => {
    expect(installTokenSchema.parse({})).toEqual({ expiresInSeconds: 900 });
    expect(() => installTokenSchema.parse({ expiresInSeconds: 30 })).toThrow();
    expect(() => exchangeSchema.parse({ installToken: "short" })).toThrow();
  });
});

describe("notification channel schemas", () => {
  it("rejects credential-bearing webhook URLs", () => {
    expect(() => createChannelSchema.parse({ type: "webhook", name: "ops", url: "https://user:pass@example.com/hook", secret: "a".repeat(16) })).toThrow(/账号密码/);
  });

  it("accepts valid Telegram channel credentials", () => {
    expect(createChannelSchema.parse({ type: "telegram", name: "ops", botToken: `123456:${"a".repeat(24)}`, chatId: "-100123456" })).toMatchObject({ type: "telegram", enabled: true });
  });
});
