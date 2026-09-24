import { describe, expect, it } from "vitest";

import { cloudProxyCheckSchema, cloudProxyUpdateSchema, cloudProxyProfileSchema, cloudProxySelectionSchema } from "./cloud-proxy.js";

describe("cloud proxy request contracts", () => {
  it("accepts setting, clearing, draft checking, and saved checking", () => {
    expect(cloudProxyUpdateSchema.parse({ proxyUrl: "socks5h://user:pass@proxy.example:1080" })).toEqual({ proxyUrl: "socks5h://user:pass@proxy.example:1080" });
    expect(cloudProxyUpdateSchema.parse({ proxyUrl: null })).toEqual({ proxyUrl: null });
    expect(cloudProxyCheckSchema.parse({})).toEqual({});
    expect(cloudProxyCheckSchema.parse({ proxyUrl: "socks5://proxy.example:1080" })).toEqual({ proxyUrl: "socks5://proxy.example:1080" });
  });

  it.each([
    {},
    { proxyUrl: "" },
    { proxyUrl: "http://proxy.example:8080" },
    { proxyUrl: "socks5h://proxy.example:1080/path" },
    { proxyUrl: null, extra: true },
  ])("rejects invalid update payload %#", payload => {
    expect(cloudProxyUpdateSchema.safeParse(payload).success).toBe(false);
  });

  it("validates reusable named profiles and account selection", () => {
    const id = "41ec869f-4b09-49b8-b419-e7a9c6cf2f33";
    expect(cloudProxyProfileSchema.parse({ name: "东京出口", proxyUrl: "socks5h://user:pass@proxy.example:1080" })).toMatchObject({ name: "东京出口" });
    expect(cloudProxySelectionSchema.parse({ proxyId: id })).toEqual({ proxyId: id });
    expect(cloudProxySelectionSchema.parse({ proxyId: null })).toEqual({ proxyId: null });
    expect(cloudProxySelectionSchema.safeParse({ proxyUrl: "socks5h://proxy.example:1080" }).success).toBe(false);
    expect(cloudProxyProfileSchema.safeParse({ name: " ", proxyUrl: "socks5h://proxy.example:1080" }).success).toBe(false);
  });
});
