import { describe, expect, it } from "vitest";
import { createProbeAgentConfigJson, createProbeInstallInstructions } from "./probe-install";

describe("createProbeAgentConfigJson", () => {
  const input = { serverUrl: "https://dns.example.com/", probeId: "33333333-3333-4333-8333-333333333333", maxConcurrency: 16 };

  it("creates a complete enrollment config with the selected probe and Linux service paths", () => {
    const json = createProbeAgentConfigJson(input);
    expect(JSON.parse(json)).toEqual({
      serverUrl: "https://dns.example.com",
      caFile: "",
      probeId: input.probeId,
      tokenFile: "/etc/masterdns-agent/runtime-token",
      stateDir: "/var/lib/masterdns-agent",
      maxConcurrency: 16,
      allowIpv4: true,
      allowIpv6: true,
      allowedPrivateCidrs: [],
    });
    expect(json).toContain('\n  "serverUrl":');
  });

  it("supports manual installation without a release version or embedded credentials", () => {
    const config = JSON.parse(createProbeAgentConfigJson({ ...input, platform: "manual" }));
    expect(config.tokenFile).toBe("./runtime-token");
    expect(config.stateDir).toBe("./state");
    expect(config).not.toHaveProperty("installToken");
    expect(config).not.toHaveProperty("runtimeToken");
  });

  it("respects the Agent concurrency limit even when the platform permits 100", () => {
    expect(JSON.parse(createProbeAgentConfigJson({ ...input, maxConcurrency: 100 })).maxConcurrency).toBe(64);
    expect(JSON.parse(createProbeAgentConfigJson({ ...input, maxConcurrency: 1 })).maxConcurrency).toBe(1);
  });

  it("rejects server URLs the Agent cannot enroll against", () => {
    expect(() => createProbeAgentConfigJson({ ...input, serverUrl: "http://dns.example.com" })).toThrow(/HTTPS/);
    expect(() => createProbeAgentConfigJson({ ...input, serverUrl: "https://user:password@dns.example.com" })).toThrow();
  });
});

describe("createProbeInstallInstructions", () => {
  it("uses the fixed trusted release and keeps the token out of shell commands", () => {
    const result = createProbeInstallInstructions({
      version: "v1.4.2",
      serverUrl: "https://dns.example.com",
      installToken: "one-time-secret",
      expiresAt: "2026-09-15T03:00:00.000Z",
    });

    expect(result.downloadUrl).toBe("https://github.com/Bend-Function/MasterDNS-Agent/releases/download/v1.4.2/install.sh");
    expect(result.installCommand).toContain("install --version 'v1.4.2' --server-url 'https://dns.example.com'");
    expect(result.enrollCommand).toBe("sudo -u masterdns-agent /usr/local/bin/masterdns-agent enroll --config /etc/masterdns-agent/config.json");
    expect(result.startCommand).toBe("sudo systemctl start masterdns-agent");
    expect(`${result.downloadUrl}\n${result.installCommand}\n${result.enrollCommand}`).not.toContain("one-time-secret");
  });

  it("refuses mutable versions and non-HTTPS enrollment servers", () => {
    expect(() => createProbeInstallInstructions({ version: "latest", serverUrl: "https://dns.example.com", installToken: "secret", expiresAt: "2026-09-15T03:00:00.000Z" })).toThrow(/pinned/i);
    expect(() => createProbeInstallInstructions({ version: "v1.4.2", serverUrl: "http://dns.example.com", installToken: "secret", expiresAt: "2026-09-15T03:00:00.000Z" })).toThrow(/HTTPS/);
  });

  it("quotes an HTTPS server URL as one shell argument", () => {
    const result = createProbeInstallInstructions({ version: "v1.4.2", serverUrl: "https://dns.example.com/a'b", installToken: "secret", expiresAt: "2026-09-15T03:00:00.000Z" });

    expect(result.installCommand).toContain("--server-url 'https://dns.example.com/a'\"'\"'b'");
  });
});
