import { describe, expect, it } from "vitest";
import { normalizeDdnsSourceIp, parseDdnsBearerToken } from "./ddns-auth.js";

describe("DDNS request authentication", () => {
  const token = "a".repeat(43);

  it("accepts the generated base64url token format", () => {
    expect(parseDdnsBearerToken(`Bearer ${token}`)).toBe(token);
    expect(parseDdnsBearerToken(`bearer\t${token}`)).toBe(token);
  });

  it("rejects missing, short, malformed, or whitespace-padded tokens", () => {
    expect(() => parseDdnsBearerToken(undefined)).toThrow(/DDNS 运行 Token/);
    expect(() => parseDdnsBearerToken("Bearer short")).toThrow(/DDNS 运行 Token/);
    expect(() => parseDdnsBearerToken(`Bearer ${token} `)).toThrow(/DDNS 运行 Token/);
    expect(() => parseDdnsBearerToken(`Bearer ${token}:extra`)).toThrow(/DDNS 运行 Token/);
  });
});

describe("DDNS source IP normalization", () => {
  it("unwraps IPv4-mapped IPv6 addresses", () => {
    expect(normalizeDdnsSourceIp("::ffff:192.0.2.20")).toBe("192.0.2.20");
    expect(normalizeDdnsSourceIp("::FFFF:192.0.2.21")).toBe("192.0.2.21");
  });

  it("preserves valid IPs and rejects non-address input", () => {
    expect(normalizeDdnsSourceIp("2001:db8::20")).toBe("2001:db8::20");
    expect(normalizeDdnsSourceIp("not-an-ip")).toBeUndefined();
  });
});
