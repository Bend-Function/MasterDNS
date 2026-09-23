import { GetStaticIpCommand, GetStaticIpsCommand, ReleaseStaticIpCommand } from "@aws-sdk/client-lightsail";
import type { StaticIp } from "@aws-sdk/client-lightsail";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { describe, expect, it } from "vitest";

import { LightsailCloudAdapter } from "./lightsail.js";
import type { AwsSend, IdleStaticIp } from "./provider.js";

const account = "123456789012";
const region = "us-east-1";
const credentials = { kind: "access_key" as const, accessKeyId: "fake", secretAccessKey: "fake" };
const target: IdleStaticIp = {
  region, name: "unused-ip", address: "198.51.100.9",
  arn: "arn:aws:lightsail:us-east-1:123456789012:StaticIp/original",
  createdAt: "2026-09-20T10:00:00.000Z",
};
const allocation: StaticIp = {
  name: "unused-ip", ipAddress: "198.51.100.9",
  arn: "arn:aws:lightsail:us-east-1:123456789012:StaticIp/original",
  createdAt: new Date("2026-09-20T10:00:00.000Z"),
  location: { regionName: region }, resourceType: "StaticIp", isAttached: false,
};
const cloudError = (name: string) => Object.assign(new Error("redacted SDK error"), { name });
const missing = () => cloudError("NotFoundException");
const adapter = (send: AwsSend, remoteAccount = account) => new LightsailCloudAdapter("local", credentials, {
  stsSend: async command => {
    expect(command).toBeInstanceOf(GetCallerIdentityCommand);
    return { Account: remoteAccount };
  },
  lightsailSend: send,
});

describe("Lightsail idle static IP discovery", () => {
  it("includes complete idle allocations from every SDK page", async () => {
    const requests: unknown[] = [];
    const cloud = adapter(async command => {
      expect(command).toBeInstanceOf(GetStaticIpsCommand);
      requests.push(command.input);
      return command.input.pageToken === undefined
        ? { staticIps: [allocation], nextPageToken: "page-two" }
        : { staticIps: [{ ...allocation, name: "second", arn: "arn:aws:lightsail:us-east-1:123456789012:StaticIp/second", ipAddress: "198.51.100.10" }] };
    });
    await expect(cloud.listIdleStaticIps(region)).resolves.toEqual([
      target,
      { ...target, name: "second", arn: "arn:aws:lightsail:us-east-1:123456789012:StaticIp/second", address: "198.51.100.10" },
    ]);
    expect(requests).toEqual([{ pageToken: undefined }, { pageToken: "page-two" }]);
  });

  it.each([
    { isAttached: true }, { isAttached: undefined }, { attachedTo: "instance" }, { attachedTo: "" },
    { name: undefined }, { name: "" }, { ipAddress: "not-an-ip" }, { ipAddress: "2001:db8::1" },
    { createdAt: undefined }, { createdAt: new Date("invalid") }, { arn: undefined },
    { arn: "arn:aws:lightsail:us-east-1:123456789012:StaticIp/" },
    { arn: "arn:aws:ec2:us-east-1:123456789012:StaticIp/original" },
    { arn: "arn:aws:lightsail:us-east-1:123456789012:Instance/original" },
    { arn: "arn:aws:lightsail:us-west-2:123456789012:StaticIp/original" },
    { arn: "arn:aws:lightsail:us-east-1:999999999999:StaticIp/original" },
    { location: { regionName: "us-west-2" } }, { resourceType: "Instance" },
  ] satisfies Partial<StaticIp>[])("excludes attached or ambiguous allocation %j", async patch => {
    const cloud = adapter(async () => ({ staticIps: [{ ...allocation, ...patch }] }));
    await expect(cloud.listIdleStaticIps(region)).resolves.toEqual([]);
  });

  it("uses the caller identity rather than trusting the local account identifier", async () => {
    const cloud = adapter(async () => ({ staticIps: [allocation] }), "999999999999");
    await expect(cloud.listIdleStaticIps(region)).resolves.toEqual([]);
  });

  it("fails discovery on a denied page instead of returning an incomplete preview", async () => {
    const cloud = adapter(async command => {
      if (command.input.pageToken === undefined) return { staticIps: [allocation], nextPageToken: "denied" };
      throw cloudError("AccessDeniedException");
    });
    await expect(cloud.listIdleStaticIps(region)).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("rejects a repeated pagination cursor instead of looping or returning partial candidates", async () => {
    const requests: Array<string | undefined> = [];
    const cloud = adapter(async command => {
      requests.push(command.input.pageToken);
      return { staticIps: [allocation], nextPageToken: ["page-a", "page-b", "page-a"][requests.length - 1] };
    });
    await expect(cloud.listIdleStaticIps(region)).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(requests).toEqual([undefined, "page-a", "page-b"]);
  });
});

describe("Lightsail idle static IP release", () => {
  it("rechecks the exact allocation, releases once, and verifies remote absence", async () => {
    const requests: unknown[] = [];
    let released = false;
    const cloud = adapter(async command => {
      requests.push([command.constructor.name, command.input]);
      if (command instanceof GetStaticIpCommand) {
        if (released) throw missing();
        return { staticIp: allocation };
      }
      expect(command).toBeInstanceOf(ReleaseStaticIpCommand);
      released = true;
      return { operations: [{ id: "release-1", status: "Succeeded" }, { id: "release-2", status: "Succeeded" }] };
    });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toEqual({ status: "released", operationIds: ["release-1", "release-2"] });
    expect(requests).toEqual([
      ["GetStaticIpCommand", { staticIpName: "unused-ip" }],
      ["ReleaseStaticIpCommand", { staticIpName: "unused-ip" }],
      ["GetStaticIpCommand", { staticIpName: "unused-ip" }],
    ]);
  });

  it.each([
    { isAttached: true }, { attachedTo: "now-used" }, { isAttached: undefined },
    { arn: "arn:aws:lightsail:us-east-1:123456789012:StaticIp/recreated" },
    { ipAddress: "198.51.100.10" }, { createdAt: new Date("2026-09-21T10:00:00.000Z") },
    { name: "different" }, { location: { regionName: "us-west-2" } },
  ] satisfies Partial<StaticIp>[])("never releases an attached or replaced allocation %j", async patch => {
    const requests: string[] = [];
    const cloud = adapter(async command => {
      requests.push(command.constructor.name);
      return { staticIp: { ...allocation, ...patch } };
    });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toMatchObject({ status: "skipped" });
    expect(requests).toEqual(["GetStaticIpCommand"]);
  });

  it("rejects a selected allocation owned by another caller before any Lightsail call", async () => {
    const requests: string[] = [];
    const cloud = adapter(async command => { requests.push(command.constructor.name); return { staticIp: allocation }; }, "999999999999");
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toMatchObject({ status: "skipped", reason: "remote_identity_changed" });
    expect(requests).toEqual([]);
  });

  it("reports a genuine not-found recheck as already missing without a release", async () => {
    const requests: string[] = [];
    const cloud = adapter(async command => { requests.push(command.constructor.name); throw missing(); });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toEqual({ status: "missing" });
    expect(requests).toEqual(["GetStaticIpCommand"]);
  });

  it("treats an empty GetStaticIp response as ambiguous, never missing", async () => {
    const requests: string[] = [];
    const cloud = adapter(async command => { requests.push(command.constructor.name); return {}; });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toMatchObject({ status: "skipped" });
    expect(requests).toEqual(["GetStaticIpCommand"]);
  });

  it("propagates read permission errors without issuing a release", async () => {
    const requests: string[] = [];
    const cloud = adapter(async command => { requests.push(command.constructor.name); throw cloudError("AccessDeniedException"); });
    await expect(cloud.releaseIdleStaticIp(target)).rejects.toMatchObject({ code: "permission_denied" });
    expect(requests).toEqual(["GetStaticIpCommand"]);
  });

  it("does not consider a succeeded operation complete while the allocation still exists", async () => {
    let writes = 0;
    const cloud = adapter(async command => {
      if (command instanceof GetStaticIpCommand) return { staticIp: allocation };
      writes++;
      return { operations: [{ id: "release-1", status: "Succeeded" }] };
    });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toMatchObject({ status: "pending", operationIds: ["release-1"] });
    expect(writes).toBe(1);
  });

  it("reconciles a lost release response through remote absence without retrying the mutation", async () => {
    let writes = 0;
    const cloud = adapter(async command => {
      if (command instanceof GetStaticIpCommand) {
        if (writes > 0) throw missing();
        return { staticIp: allocation };
      }
      writes++;
      throw cloudError("TimeoutError");
    });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toEqual({ status: "released" });
    expect(writes).toBe(1);
  });

  it("leaves a lost response pending while the same allocation is still present", async () => {
    let writes = 0;
    const cloud = adapter(async command => {
      if (command instanceof GetStaticIpCommand) return { staticIp: allocation };
      writes++;
      throw cloudError("TimeoutError");
    });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toEqual({ status: "pending", reason: "temporary_cloud_error" });
    expect(writes).toBe(1);
  });

  it.each([
    ["AccessDeniedException", "permission_denied"],
    ["QuotaExceededException", "quota_exceeded"],
    ["ThrottlingException", "rate_limited"],
    ["ExpiredTokenException", "credentials_expired"],
    ["InvalidClientTokenId", "invalid_credentials"],
  ])("marks a %s release rejection as no-effect only after the target is observed", async (name, reason) => {
    let writes = 0;
    const cloud = adapter(async command => {
      if (command instanceof GetStaticIpCommand) return { staticIp: allocation };
      writes++;
      throw cloudError(name);
    });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toEqual({ status: "pending", reason, rejectedNoEffect: true });
    expect(writes).toBe(1);
  });

  it("marks an explicit rejected release as no-effect when the same allocation becomes attached", async () => {
    let writes = 0;
    const cloud = adapter(async command => {
      if (command instanceof GetStaticIpCommand) return { staticIp: writes === 0 ? allocation : { ...allocation, isAttached: true, attachedTo: "instance" } };
      writes++;
      throw cloudError("ThrottlingException");
    });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toEqual({ status: "pending", reason: "rate_limited", rejectedNoEffect: true });
    expect(writes).toBe(1);
  });

  it("preserves the vendor retry delay after an explicit throttled release rejection", async () => {
    const cloud = adapter(async command => {
      if (command instanceof GetStaticIpCommand) return { staticIp: allocation };
      throw Object.assign(cloudError("ThrottlingException"), { retryAfterSeconds: 240 });
    });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toEqual({
      status: "pending", reason: "rate_limited", rejectedNoEffect: true, retryAfterMs: 240_000,
    });
  });

  it("preserves the observation retry delay after an accepted release", async () => {
    let released = false;
    const cloud = adapter(async command => {
      if (command instanceof GetStaticIpCommand) {
        if (released) throw Object.assign(cloudError("ThrottlingException"), { retryAfterSeconds: 180 });
        return { staticIp: allocation };
      }
      released = true;
      return { operations: [{ id: "release-1", status: "Started" }] };
    });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toEqual({
      status: "pending", reason: "rate_limited", retryAfterMs: 180_000, operationIds: ["release-1"],
    });
  });

  it("keeps a rejected release uncertain when observation cannot confirm the original allocation", async () => {
    let writes = 0;
    const cloud = adapter(async command => {
      if (command instanceof GetStaticIpCommand) {
        if (writes > 0) throw cloudError("AccessDeniedException");
        return { staticIp: allocation };
      }
      writes++;
      throw cloudError("ThrottlingException");
    });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toEqual({ status: "pending", reason: "rate_limited" });
    expect(writes).toBe(1);
  });

  it("does not flag a known release rejection as retryable when the same name was recreated", async () => {
    let writes = 0;
    const cloud = adapter(async command => {
      if (command instanceof GetStaticIpCommand) return { staticIp: writes === 0 ? allocation : { ...allocation, arn: "arn:aws:lightsail:us-east-1:123456789012:StaticIp/recreated" } };
      writes++;
      throw cloudError("ThrottlingException");
    });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toEqual({ status: "pending", reason: "rate_limited" });
    expect(writes).toBe(1);
  });

  it("reports observed absence as released even after an explicit release rejection", async () => {
    let writes = 0;
    const cloud = adapter(async command => {
      if (command instanceof GetStaticIpCommand) {
        if (writes > 0) throw missing();
        return { staticIp: allocation };
      }
      writes++;
      throw cloudError("ThrottlingException");
    });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toEqual({ status: "released" });
    expect(writes).toBe(1);
  });

  it("leaves an accepted release pending when its verification read fails", async () => {
    let writes = 0;
    const cloud = adapter(async command => {
      if (command instanceof GetStaticIpCommand) {
        if (writes > 0) throw cloudError("AccessDeniedException");
        return { staticIp: allocation };
      }
      writes++;
      return { operations: [{ id: "release-1", status: "Started" }] };
    });
    await expect(cloud.releaseIdleStaticIp(target)).resolves.toEqual({ status: "pending", reason: "permission_denied", operationIds: ["release-1"] });
    expect(writes).toBe(1);
  });
});

describe("Lightsail idle release observation", () => {
  it.each([
    { value: allocation, status: "pending", reason: "release_pending" },
    { value: { ...allocation, isAttached: true, attachedTo: "instance" }, status: "skipped", reason: "attached" },
    { value: { ...allocation, arn: "arn:aws:lightsail:us-east-1:123456789012:StaticIp/new" }, status: "skipped", reason: "remote_identity_changed" },
  ])("only reads a previously attempted allocation and returns $status", async ({ value, status, reason }) => {
    const requests: string[] = [];
    const cloud = adapter(async command => { requests.push(command.constructor.name); return { staticIp: value }; });
    await expect(cloud.observeIdleStaticIp(target)).resolves.toEqual({ status, reason });
    expect(requests).toEqual(["GetStaticIpCommand"]);
  });

  it("confirms an attempted release only from a genuine NotFound read", async () => {
    const cloud = adapter(async () => { throw missing(); });
    await expect(cloud.observeIdleStaticIp(target)).resolves.toEqual({ status: "released" });
  });

  it("keeps an empty observation or denied read pending", async () => {
    await expect(adapter(async () => ({})).observeIdleStaticIp(target)).resolves.toMatchObject({ status: "pending" });
    await expect(adapter(async () => { throw cloudError("AccessDeniedException"); }).observeIdleStaticIp(target)).resolves.toEqual({ status: "pending", reason: "permission_denied" });
  });

  it("preserves a vendor retry delay for a throttled observation", async () => {
    const cloud = adapter(async () => { throw Object.assign(cloudError("ThrottlingException"), { retryAfterSeconds: 210 }); });
    await expect(cloud.observeIdleStaticIp(target)).resolves.toEqual({ status: "pending", reason: "rate_limited", retryAfterMs: 210_000 });
  });

  it("preserves a retry delay when observation identity verification is throttled", async () => {
    const cloud = new LightsailCloudAdapter("local", credentials, {
      stsSend: async () => { throw Object.assign(cloudError("ThrottlingException"), { retryAfterSeconds: 300 }); },
      lightsailSend: async () => { throw new Error("identity verification must succeed before Lightsail calls"); },
    });
    await expect(cloud.observeIdleStaticIp(target)).resolves.toEqual({ status: "pending", reason: "rate_limited", retryAfterMs: 300_000 });
  });
});
