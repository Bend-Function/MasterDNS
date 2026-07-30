import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildDdnsInstallCommand,
  currentRuntimeTokenMatches,
  resolveAgentScriptPath,
  resolveDdnsAddressUpdates,
  rotateRuntimeToken,
  runtimeTokenMatches,
} from "./ddns-policy.js";

describe("DDNS runtime token policy", () => {
  const now = new Date("2026-07-30T12:00:00.000Z");

  it("accepts the current token and a non-expired previous token", () => {
    expect(runtimeTokenMatches({
      runtimeTokenHash: "current",
      previousRuntimeTokenHash: "previous",
      previousRuntimeTokenExpiresAt: new Date("2026-07-30T12:10:00.000Z"),
    }, "current", now)).toBe(true);
    expect(runtimeTokenMatches({
      runtimeTokenHash: "current",
      previousRuntimeTokenHash: "previous",
      previousRuntimeTokenExpiresAt: new Date("2026-07-30T12:10:00.000Z"),
    }, "previous", now)).toBe(true);
  });

  it("rejects an expired previous token", () => {
    expect(runtimeTokenMatches({
      runtimeTokenHash: "current",
      previousRuntimeTokenHash: "previous",
      previousRuntimeTokenExpiresAt: now,
    }, "previous", now)).toBe(false);
  });

  it("allows only the current token to perform self-revocation", () => {
    expect(currentRuntimeTokenMatches({ runtimeTokenHash: "current" }, "current")).toBe(true);
    expect(currentRuntimeTokenMatches({ runtimeTokenHash: "current" }, "previous")).toBe(false);
  });

  it("rotates the current token into a ten-minute grace window", () => {
    expect(rotateRuntimeToken("old", "new", now)).toEqual({
      runtimeTokenHash: "new",
      previousRuntimeTokenHash: "old",
      previousRuntimeTokenExpiresAt: new Date("2026-07-30T12:10:00.000Z"),
    });
    expect(rotateRuntimeToken(null, "new", now).previousRuntimeTokenExpiresAt).toBeNull();
  });
});

describe("DDNS install policy", () => {
  it("builds an HTTPS command without putting an install token in argv", () => {
    const result = buildDdnsInstallCommand("https://dns.example.com/");
    expect(result.command).toMatch(/^curl -q /);
    expect(result.command).toContain("--proto '=https'");
    expect(result.command).toContain("--proto-redir '=https'");
    expect(result.command).toContain("--url 'https://dns.example.com'");
    expect(result.command).not.toContain("--token");
    expect(result.command).not.toContain("--noproxy");
    expect(result.allowInsecureLoopback).toBe(false);
  });

  it("requires an explicit flag for loopback HTTP and rejects remote HTTP", () => {
    const command = buildDdnsInstallCommand("http://127.0.0.1:3000").command;
    expect(command).toContain("--allow-insecure-loopback");
    expect(command).toContain("--noproxy '*'");
    expect(() => buildDdnsInstallCommand("http://dns.example.com")).toThrow(/HTTPS/);
  });

  it("rejects credential-bearing or ambiguous public URLs", () => {
    expect(() => buildDdnsInstallCommand("https://user:pass@dns.example.com")).toThrow(/账号/);
    expect(() => buildDdnsInstallCommand("https://dns.example.com?next=http://evil.example")).toThrow(/查询参数/);
    expect(() => buildDdnsInstallCommand("https://dns.example.com?")).toThrow(/查询参数/);
    expect(() => buildDdnsInstallCommand("https://dns.example.com#")).toThrow(/片段/);
    expect(() => buildDdnsInstallCommand(" https://dns.example.com")).toThrow(/空白/);
  });
});

describe("DDNS address policy", () => {
  it("uses the request source when public IPv4 discovery reports null", () => {
    expect(resolveDdnsAddressUpdates({ ipv4: null, ipv6: "2001:db8::1" }, "192.0.2.8")).toEqual([
      { family: "4", address: "192.0.2.8" },
      { family: "6", address: "2001:db8::1" },
    ]);
  });

  it("preserves explicit null as a family withdrawal", () => {
    expect(resolveDdnsAddressUpdates({ ipv6: null }, "192.0.2.8")).toEqual([
      { family: "6", address: null },
      { family: "4", address: "192.0.2.8" },
    ]);
  });

  it("adds the inferred source family when only the other family was reported", () => {
    expect(resolveDdnsAddressUpdates({ ipv6: "2001:db8::1" }, "192.0.2.8")).toEqual([
      { family: "6", address: "2001:db8::1" },
      { family: "4", address: "192.0.2.8" },
    ]);
  });

  it("resolves bundled scripts relative to the module, not process cwd", async () => {
    const scriptPath = resolveAgentScriptPath("install.sh");
    expect(scriptPath).toMatch(/\/agent\/install\.sh$/);
    expect(await readFile(scriptPath, "utf8")).toMatch(/^#!\/bin\/sh/);
  });
});
