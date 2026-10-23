import Cloudflare from "cloudflare";
import { expect, it, vi } from "vitest";
import { CloudflareDnsAdapter, mapCloudflareError } from "./cloudflare.js";

it.each([400, 422])("preserves safe Cloudflare validation diagnostics from an update (HTTP %s)", async status => {
  const failure = new Cloudflare.APIError(status, {
    errors: [{ code: 1004, message: "secret-response-value", error_chain: [
      { code: 9000, message: "secret-record-value", source: { pointer: "/content" } },
    ] }],
  }, "secret-sdk-message", new Headers({ authorization: "Bearer secret-token" }));
  const adapter = new CloudflareDnsAdapter("secret-token", {
    dns: { records: { update: vi.fn().mockRejectedValue(failure) } },
  } as never);

  const error = await adapter.updateRecord("zone", "record", {
    type: "A", name: "www.example.com", content: "192.0.2.20", ttl: 60, providerMetadata: {},
  }).catch(error => error);
  expect(error).toMatchObject({ code: "validation_failed", retryable: false });
  expect(error.message).toContain(`HTTP ${status}`);
  expect(error.message).toContain("1004");
  expect(error.message).toContain("9000");
  expect(error.message).toContain("/content");
  expect(error.message).not.toContain("secret");
});

it("ignores arbitrary strings and unknown fields in validation diagnostics", () => {
  const error = mapCloudflareError(new Cloudflare.APIError(400, { errors: [
    { code: "secret-code", message: "secret-message", source: { pointer: "/secret-token" } },
    { code: 1004, source: { pointer: "/ttl" } },
    { code: 9000, source: { pointer: "/content/secret-value" } },
  ] }, "secret-sdk-message", new Headers()));
  expect(error.message).toContain("1004");
  expect(error.message).toContain("/ttl");
  expect(error.message).not.toContain("secret");
});

it("handles absent or malformed Cloudflare errors without losing the classification", () => {
  for (const errors of [undefined, null, {}, [null, "invalid", { code: 1.5 }]]) {
    const error = mapCloudflareError(new Cloudflare.APIError(400, { errors }, undefined, new Headers()));
    expect(error).toMatchObject({ code: "validation_failed", retryable: false });
    expect(error.message).toContain("HTTP 400");
  }
});

it("bounds the persisted validation detail even for oversized error chains", () => {
  const error = mapCloudflareError(new Cloudflare.APIError(400, {
    errors: Array.from({ length: 1000 }, (_, index) => ({ code: 9000 + index, source: { pointer: "/content" } })),
  }, undefined, new Headers()));
  expect(error.message).toContain("9000");
  expect(error.message.length).toBeLessThanOrEqual(512);
});
