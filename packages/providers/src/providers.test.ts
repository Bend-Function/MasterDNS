import { describe, expect, it } from "vitest";
import { mapAliyunError, normalizeAliyunRecord } from "./aliyun.js";
import { mapCloudflareError, normalizeCloudflareRecord } from "./cloudflare.js";

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
