import { describe, expect, it } from "vitest";
import { parseProxyUrl, proxyErrorMessage } from "./cloud-proxy";

describe("cloud account SOCKS proxy", () => {
  it("accepts socks5 and socks5h URLs with a hostname and port", () => {
    expect(parseProxyUrl("socks5h://user:secret@proxy.example.com:1080")).toEqual({
      proxyUrl: "socks5h://user:secret@proxy.example.com:1080",
      sanitizedEndpoint: "socks5h://proxy.example.com:1080",
    });
    expect(parseProxyUrl("socks5://127.0.0.1:1080").sanitizedEndpoint).toBe("socks5://127.0.0.1:1080");
  });

  it("rejects unsupported schemes, missing ports, and URL fragments", () => {
    expect(() => parseProxyUrl("http://proxy.example.com:8080")).toThrow(/socks5/);
    expect(() => parseProxyUrl("socks5h://proxy.example.com")).toThrow(/端口/);
    expect(() => parseProxyUrl("socks5h://proxy.example.com:1080/#secret")).toThrow(/路径/);
  });

  it("never repeats a credential-bearing draft in an error message", () => {
    const draft = "socks5h://alice:secret@proxy.example.com:1080";
    expect(proxyErrorMessage(new Error(`failed ${draft}`), draft)).toBe("failed [代理地址]");
  });
});
