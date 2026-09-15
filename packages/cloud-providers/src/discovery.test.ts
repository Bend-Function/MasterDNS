import {
  DescribeInstancesCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRegionsCommand,
} from "@aws-sdk/client-ec2";
import { GetInstanceCommand, GetInstancesCommand, GetRegionsCommand, GetStaticIpsCommand } from "@aws-sdk/client-lightsail";
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
            { address: "198.51.100.10", family: 4, primary: false, allocationId: "eipalloc-01" },
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
