import {
  DescribeInstancesCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRegionsCommand,
} from "@aws-sdk/client-ec2";
import { GetInstanceCommand, GetInstancesCommand, GetRegionsCommand, GetStaticIpCommand, GetStaticIpsCommand } from "@aws-sdk/client-lightsail";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { describe, expect, it } from "vitest";

import { CloudError, Ec2CloudAdapter, LightsailCloudAdapter } from "./index.js";

const credentials = { kind: "access_key" as const, accessKeyId: "AKIA_REDACTED", secretAccessKey: "redacted" };

describe("AWS identity and scope discovery", () => {
  it("returns the STS account identity and enabled EC2 regions", async () => {
    const adapter = new Ec2CloudAdapter("local-account", credentials, {
      stsSend: async (command) => {
        expect(command).toBeInstanceOf(GetCallerIdentityCommand);
        return { Account: "123456789012" };
      },
      ec2Send: async (command) => {
        expect(command).toBeInstanceOf(DescribeRegionsCommand);
        return {
          Regions: [
            { RegionName: "us-east-1", OptInStatus: "opt-in-not-required" },
            { RegionName: "ap-east-1", OptInStatus: "not-opted-in" },
            { RegionName: "ap-southeast-2", OptInStatus: "opted-in" },
          ],
        };
      },
    });

    await expect(adapter.verifyIdentity()).resolves.toEqual({ externalAccountId: "123456789012" });
    await expect(adapter.listScopes()).resolves.toEqual(["ap-southeast-2", "us-east-1"]);
  });

  it("normalizes expired credentials without exposing request metadata", async () => {
    const adapter = new Ec2CloudAdapter("local-account", credentials, {
      stsSend: async () => {
        const error = Object.assign(new Error("The security token included in the request is expired: SECRET"), {
          name: "ExpiredTokenException",
          $metadata: { httpStatusCode: 403, requestId: "secret-request-id" },
        });
        throw error;
      },
      ec2Send: async () => ({}),
    });

    const error = await adapter.verifyIdentity().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudError);
    expect(error).toMatchObject({ code: "credentials_expired", retryable: false });
    expect(JSON.stringify(error)).not.toContain("SECRET");
    expect(JSON.stringify(error)).not.toContain("secret-request-id");
  });
});

describe("EC2 read adapter", () => {
  it("passes a resumed EC2 cursor to the SDK", async () => {
    const adapter = new Ec2CloudAdapter("local-account", credentials, {
      stsSend: async () => ({}),
      ec2Send: async (command) => {
        expect(command).toBeInstanceOf(DescribeInstancesCommand);
        expect(command.input).toEqual({ NextToken: "resume-token" });
        return { Reservations: [] };
      },
    });

    await expect(adapter.discover("us-east-1", "ec2:resume-token")).resolves.toEqual({ items: [] });
  });

  it("paginates instances and maps EC2 instance and interface identities", async () => {
    const adapter = new Ec2CloudAdapter("local-account", credentials, {
      stsSend: async () => ({ Account: "123456789012" }),
      ec2Send: async (command) => {
        expect(command).toBeInstanceOf(DescribeInstancesCommand);
        expect(command.input).toEqual({ NextToken: undefined });
        return {
          Reservations: [{ Instances: [{
            InstanceId: "i-0123456789",
            State: { Name: "running" },
            Tags: [{ Key: "Name", Value: "edge-one" }],
            NetworkInterfaces: [{
              NetworkInterfaceId: "eni-01",
              Attachment: { DeviceIndex: 0 },
              PrivateIpAddresses: [
                { PrivateIpAddress: "10.0.0.4", Primary: true },
                { PrivateIpAddress: "10.0.0.5", Primary: false, Association: { PublicIp: "198.51.100.10", AllocationId: "eipalloc-01" } },
              ],
              Ipv6Addresses: [{ Ipv6Address: "2001:db8::4", IsPrimaryIpv6: true }],
            }],
          }] }],
          NextToken: "sdk-token",
        };
      },
    });

    await expect(adapter.discover("ap-southeast-2")).resolves.toEqual({
      items: [{
        ref: { accountId: "local-account", service: "ec2", region: "ap-southeast-2", instanceId: "i-0123456789" },
        name: "edge-one",
        state: "running",
        interfaces: [{
          id: "eni-01",
          deviceIndex: 0,
          addresses: [
            { address: "10.0.0.4", family: 4, primary: true },
            { address: "10.0.0.5", family: 4, primary: false },
            { address: "198.51.100.10", family: 4, primary: false, allocationId: "eipalloc-01", privateAddress: "10.0.0.5" },
            { address: "2001:db8::4", family: 6, primary: true },
          ],
        }],
      }],
      cursor: "ec2:sdk-token",
    });
  });

  it("rejects a Lightsail cursor instead of mixing pagination tokens", async () => {
    const adapter = new Ec2CloudAdapter("local-account", credentials, {
      stsSend: async () => ({}),
      ec2Send: async () => { throw new Error("must not call SDK"); },
    });
    await expect(adapter.discover("us-east-1", "lightsail:token")).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("inspects the stable EC2 instance id and fetches authoritative interfaces", async () => {
    const adapter = new Ec2CloudAdapter("local-account", credentials, {
      stsSend: async () => ({}),
      ec2Send: async (command) => {
        if (command instanceof DescribeInstancesCommand) {
          expect(command.input).toEqual({ InstanceIds: ["i-0123456789"] });
          return { Reservations: [{ Instances: [{ InstanceId: "i-0123456789", State: { Name: "stopped" }, NetworkInterfaces: [] }] }] };
        }
        expect(command).toBeInstanceOf(DescribeNetworkInterfacesCommand);
        expect(command.input).toEqual({ Filters: [{ Name: "attachment.instance-id", Values: ["i-0123456789"] }] });
        return { NetworkInterfaces: [{ NetworkInterfaceId: "eni-authoritative", PrivateIpAddresses: [] }] };
      },
    });

    const inventory = await adapter.inspect({
      accountId: "local-account", service: "ec2", region: "us-east-1", instanceId: "i-0123456789",
    });
    expect(inventory.interfaces).toEqual([{ id: "eni-authoritative", addresses: [] }]);
  });

  it("classifies regional access denial", async () => {
    const adapter = new Ec2CloudAdapter("local-account", credentials, {
      stsSend: async () => ({}),
      ec2Send: async () => { throw Object.assign(new Error("denied"), { name: "UnauthorizedOperation" }); },
    });
    await expect(adapter.discover("ap-east-1")).rejects.toMatchObject({ code: "permission_denied", retryable: false });
  });
});

describe("Lightsail read adapter", () => {
  it("inspects an explicit instance and static IP without account-wide listing", async () => {
    const stableArn = "arn:aws:lightsail:us-east-1:123456789012:Instance/instance-guid";
    const requests: Array<[string, unknown]> = [];
    const adapter = new LightsailCloudAdapter("local-account", credentials, {
      lightsailSend: async (command) => {
        requests.push([command.constructor.name, command.input]);
        if (command instanceof GetInstanceCommand) return { instance: {
          name: "web-one", arn: stableArn, isStaticIp: true, publicIpAddress: "203.0.113.4", state: { name: "running" }, ipAddressType: "ipv4",
        } };
        if (command instanceof GetStaticIpCommand) return { staticIp: {
          name: "web-static", arn: "arn:aws:lightsail:us-east-1:123456789012:StaticIp/static-guid", attachedTo: "web-one", ipAddress: "203.0.113.4",
        } };
        throw new Error("account-wide request is forbidden");
      },
    });

    await expect(adapter.inspectScoped(
      { accountId: "local-account", service: "lightsail", region: "us-east-1", instanceId: stableArn },
      { mode: "initial", instanceName: "web-one", original: { kind: "static", name: "web-static", address: "203.0.113.4" } },
    )).resolves.toMatchObject({ nativeName: "web-one", interfaces: [{ addresses: expect.arrayContaining([
      expect.objectContaining({ address: "203.0.113.4", allocationId: "web-static" }),
    ]) }] });
    expect(requests).toEqual([
      ["GetInstanceCommand", { instanceName: "web-one" }],
      ["GetStaticIpCommand", { staticIpName: "web-static" }],
    ]);
  });

  it.each([
    ["instance ARN", { instanceArn: "arn:aws:lightsail:us-east-1:123456789012:Instance/recreated", address: "203.0.113.4", attachedTo: "web-one" }],
    ["static-IP address", { instanceArn: "arn:aws:lightsail:us-east-1:123456789012:Instance/instance-guid", address: "203.0.113.99", attachedTo: "web-one" }],
    ["static-IP attachment", { instanceArn: "arn:aws:lightsail:us-east-1:123456789012:Instance/instance-guid", address: "203.0.113.4", attachedTo: "other" }],
  ])("rejects a scoped Lightsail %s mismatch", async (_label, mismatch) => {
    const stableArn = "arn:aws:lightsail:us-east-1:123456789012:Instance/instance-guid";
    const adapter = new LightsailCloudAdapter("local-account", credentials, {
      lightsailSend: async (command) => {
        if (command instanceof GetInstanceCommand) return { instance: {
          name: "web-one", arn: mismatch.instanceArn, isStaticIp: true, publicIpAddress: "203.0.113.4",
        } };
        if (command instanceof GetStaticIpCommand) return { staticIp: {
          name: "web-static", arn: "arn:aws:lightsail:us-east-1:123456789012:StaticIp/static-guid",
          attachedTo: mismatch.attachedTo, ipAddress: mismatch.address,
        } };
        throw new Error("account-wide request is forbidden");
      },
    });

    await expect(adapter.inspectScoped(
      { accountId: "local-account", service: "lightsail", region: "us-east-1", instanceId: stableArn },
      { mode: "initial", instanceName: "web-one", original: { kind: "static", name: "web-static", address: "203.0.113.4" } },
    )).rejects.toMatchObject({ code: "remote_identity_changed" });
  });

  it("passes a resumed Lightsail cursor to the SDK", async () => {
    const adapter = new LightsailCloudAdapter("local-account", credentials, {
      stsSend: async () => ({}),
      lightsailSend: async (command) => {
        if (command instanceof GetInstancesCommand) {
          expect(command.input).toEqual({ pageToken: "resume-token" });
          return { instances: [] };
        }
        return { staticIps: [] };
      },
    });

    await expect(adapter.discover("us-east-1", "lightsail:resume-token")).resolves.toEqual({ items: [] });
  });

  it("finds an attached static IP on the second static-IP page during discovery", async () => {
    const adapter = new LightsailCloudAdapter("local-account", credentials, {
      stsSend: async () => ({}),
      lightsailSend: async (command) => {
        if (command instanceof GetInstancesCommand) {
          return { instances: [{
            name: "web-one",
            arn: "arn:aws:lightsail:us-east-1:123456789012:Instance/instance-guid",
            publicIpAddress: "203.0.113.4",
          }] };
        }
        if (command instanceof GetStaticIpsCommand) {
          if (command.input.pageToken === undefined) return { staticIps: [], nextPageToken: "static-page-2" };
          expect(command.input.pageToken).toBe("static-page-2");
          return { staticIps: [{ name: "web-static", attachedTo: "web-one", ipAddress: "203.0.113.4" }] };
        }
        throw new Error("unexpected command");
      },
    });

    const page = await adapter.discover("us-east-1");
    expect(page.items[0]?.interfaces[0]?.addresses[0]).toMatchObject({ allocationId: "web-static" });
  });

  it("finds an attached static IP on the second static-IP page during inspection", async () => {
    const stableArn = "arn:aws:lightsail:us-east-1:123456789012:Instance/instance-guid";
    const adapter = new LightsailCloudAdapter("local-account", credentials, {
      stsSend: async () => ({}),
      lightsailSend: async (command) => {
        if (command instanceof GetInstancesCommand) return { instances: [{ name: "web-one", arn: stableArn }] };
        if (command instanceof GetInstanceCommand) {
          return { instance: { name: "web-one", arn: stableArn, publicIpAddress: "203.0.113.4" } };
        }
        if (command instanceof GetStaticIpsCommand) {
          if (command.input.pageToken === undefined) return { staticIps: [], nextPageToken: "static-page-2" };
          return { staticIps: [{ name: "web-static", attachedTo: "web-one", ipAddress: "203.0.113.4" }] };
        }
        throw new Error("unexpected command");
      },
    });

    const inventory = await adapter.inspect({ accountId: "local-account", service: "lightsail", region: "us-east-1", instanceId: stableArn });
    expect(inventory.interfaces[0]?.addresses[0]).toMatchObject({ allocationId: "web-static" });
  });

  it("lists enabled regions and paginates instances with ARN identity and native name", async () => {
    const adapter = new LightsailCloudAdapter("local-account", credentials, {
      stsSend: async () => ({ Account: "123456789012" }),
      lightsailSend: async (command) => {
        if (command instanceof GetRegionsCommand) {
          return { regions: [{ name: "us-east-1" }, { name: "eu-west-1" }] };
        }
        if (command instanceof GetInstancesCommand) {
          expect(command.input).toEqual({ pageToken: undefined });
          return { instances: [{
            name: "web-one",
            arn: "arn:aws:lightsail:us-east-1:123456789012:Instance/instance-guid",
            state: { name: "running" },
            privateIpAddress: "10.0.1.4",
            publicIpAddress: "203.0.113.4",
            ipv6Addresses: ["2001:db8::10"],
            ipAddressType: "dualstack",
          }], nextPageToken: "next" };
        }
        expect(command).toBeInstanceOf(GetStaticIpsCommand);
        return { staticIps: [{ name: "web-static", attachedTo: "web-one", ipAddress: "203.0.113.4" }] };
      },
    });

    await expect(adapter.listScopes()).resolves.toEqual(["eu-west-1", "us-east-1"]);
    await expect(adapter.discover("us-east-1")).resolves.toEqual({
      items: [{
        ref: { accountId: "local-account", service: "lightsail", region: "us-east-1", instanceId: "arn:aws:lightsail:us-east-1:123456789012:Instance/instance-guid" },
        nativeName: "web-one",
        name: "web-one",
        state: "running",
        ipv6Only: false,
        interfaces: [{ id: "primary", addresses: [
          { address: "10.0.1.4", family: 4, primary: true },
          { address: "203.0.113.4", family: 4, primary: true, allocationId: "web-static" },
          { address: "2001:db8::10", family: 6, primary: true },
        ] }],
      }],
      cursor: "lightsail:next",
    });
  });

  it("looks up a Lightsail name then rejects a recreated same-name instance", async () => {
    const stableArn = "arn:aws:lightsail:us-east-1:123456789012:Instance/original-guid";
    const adapter = new LightsailCloudAdapter("local-account", credentials, {
      stsSend: async () => ({}),
      lightsailSend: async (command) => {
        if (command instanceof GetInstancesCommand) {
          return { instances: [{ name: "web-one", arn: stableArn }] };
        }
        if (command instanceof GetInstanceCommand) {
          expect(command.input).toEqual({ instanceName: "web-one" });
          return { instance: { name: "web-one", arn: stableArn.replace("original", "replacement"), state: { name: "running" } } };
        }
        return { staticIps: [] };
      },
    });

    await expect(adapter.inspect({ accountId: "local-account", service: "lightsail", region: "us-east-1", instanceId: stableArn }))
      .rejects.toMatchObject({ code: "remote_identity_changed", retryable: false });
  });
});

it("keeps missing Lightsail addressing metadata unknown rather than claiming dual-stack support", async () => {
  const adapter = new LightsailCloudAdapter("local-account", credentials, {
    lightsailSend: async command => command instanceof GetInstancesCommand
      ? { instances: [{ name: "one", arn: "arn:one", ipv6Addresses: ["2001:db8::1"] }] }
      : { staticIps: [] },
  });
  const inventory = (await adapter.discover("us-east-1")).items[0]!;
  const slot = { ...inventory.ref, slotId: "v6", interfaceId: "primary", family: 6 as const, address: "2001:db8::1" };
  expect(adapter.capabilities(slot, inventory)).toMatchObject({ available: false, reason: "lightsail_address_type_unknown" });
});
