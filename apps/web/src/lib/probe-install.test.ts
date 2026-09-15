import { describe, expect, it } from "vitest";
import { createProbeInstallInstructions } from "./probe-install";

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
