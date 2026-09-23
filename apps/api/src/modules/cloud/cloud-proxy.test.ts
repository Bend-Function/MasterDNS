import { describe, expect, it } from "vitest";

import { cloudProxyCheckSchema, cloudProxyUpdateSchema } from "./cloud-proxy.js";

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
});
