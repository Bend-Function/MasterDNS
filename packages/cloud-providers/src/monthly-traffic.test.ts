import { describe, expect, it } from "vitest";
import { Ec2CloudAdapter } from "./ec2.js";
import { LightsailCloudAdapter } from "./lightsail.js";
import { AzureCloudAdapter } from "./azure.js";
import { LinodeCloudAdapter } from "./linode.js";

const now = new Date("2026-09-20T13:00:00Z");
const aws = { kind: "access_key" as const, accessKeyId: "test", secretAccessKey: "test" };
const ref = { accountId: "account", service: "ec2" as const, region: "us-east-1", instanceId: "i-1234567890abcdef0" };

describe("monthly instance traffic", () => {
  it("sums EC2 bytes with a UTC month and preserves missing metrics", async () => {
    const adapter = new Ec2CloudAdapter("account", aws, { cloudwatchSend: async command => {
      expect(command.input).toMatchObject({ Namespace: "AWS/EC2", Dimensions: [{ Name: "InstanceId", Value: ref.instanceId }], StartTime: new Date("2026-09-01T00:00:00Z"), EndTime: now, Statistics: ["Sum"], Period: 3600, Unit: "Bytes" });
      return { Datapoints: command.input.MetricName === "NetworkIn" ? [{ Sum: 100 }, { Sum: 200 }] : [] };
    } });
    expect(await adapter.monthlyTraffic(ref, now)).toMatchObject({ month: "2026-09", incomingBytes: 300, outgoingBytes: null, totalBytes: null, allowance: null, source: "cloudwatch" });
  });

  it("does not turn a malformed sum into a zero-byte success", async () => {
    const adapter = new Ec2CloudAdapter("account", aws, { cloudwatchSend: async () => ({ Datapoints: [{ Sum: -1 }] }) });
    await expect(adapter.monthlyTraffic(ref, now)).rejects.toMatchObject({ code: "temporary_cloud_error" });
  });

  it("rolls into January in UTC and retains genuine zero usage", async () => {
    const adapter = new Ec2CloudAdapter("account", aws, { cloudwatchSend: async command => {
      expect(command.input.StartTime).toEqual(new Date("2027-01-01T00:00:00Z"));
      return { Datapoints: [{ Sum: 0 }] };
    } });
    expect(await adapter.monthlyTraffic(ref, new Date("2027-01-01T01:00:00Z"))).toMatchObject({ month: "2027-01", totalBytes: 0 });
  });

  it("normalizes permission failures without exposing provider text", async () => {
    const adapter = new Ec2CloudAdapter("account", aws, { cloudwatchSend: async () => { throw Object.assign(new Error("secret-key"), { name: "AccessDenied" }); } });
    await expect(adapter.monthlyTraffic(ref, now)).rejects.toMatchObject({ code: "permission_denied", message: "permission_denied" });
  });

  it("reads Lightsail usage and labels its shared bundle allowance", async () => {
    const lightsailRef = { ...ref, service: "lightsail" as const, instanceId: "arn:aws:lightsail:us-east-1:123456789012:Instance/id" };
    const adapter = new LightsailCloudAdapter("account", aws, { lightsailSend: async command => {
      if (command.constructor.name === "GetInstancesCommand") return { instances: [{ arn: lightsailRef.instanceId, name: "web" }] };
      if (command.constructor.name === "GetInstanceCommand") return { instance: { arn: lightsailRef.instanceId, name: "web", networking: { monthlyTransfer: { gbPerMonth: 1024 } } } };
      expect(command.constructor.name).toBe("GetInstanceMetricDataCommand");
      expect(command.input).toMatchObject({ instanceName: "web", startTime: new Date("2026-09-01T00:00:00Z"), endTime: now, period: 3600, statistics: ["Sum"], unit: "Bytes" });
      return { metricData: [{ sum: command.input.metricName === "NetworkIn" ? 100 : 250 }] };
    } });
    expect(await adapter.monthlyTraffic(lightsailRef, now)).toMatchObject({ incomingBytes: 100, outgoingBytes: 250, totalBytes: 350, allowance: { gigabytes: 1024, scope: "region_bundle" }, source: "lightsail" });
  });

  it("refuses reused Lightsail names before fetching their traffic", async () => {
    const adapter = new LightsailCloudAdapter("account", aws, { lightsailSend: async command => {
      if (command.constructor.name === "GetInstancesCommand") return { instances: [{ arn: "original", name: "web" }] };
      if (command.constructor.name === "GetInstanceCommand") return { instance: { arn: "replacement", name: "web" } };
      throw new Error("metrics must not be requested");
    } });
    await expect(adapter.monthlyTraffic({ ...ref, service: "lightsail", instanceId: "original" }, now)).rejects.toMatchObject({ code: "remote_identity_changed" });
  });

  it("reads Azure totals from the exact VM resource", async () => {
    const id = "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm";
    const adapter = new AzureCloudAdapter("account", { kind: "azure_service_principal", tenantId: "tenant", subscriptionId: "sub", clientId: "client", clientSecret: "secret" }, { fetch: async input => {
      const url = new URL(String(input));
      if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "token", expires_in: 3600 });
      expect(url.pathname).toBe(`${id}/providers/Microsoft.Insights/metrics`);
      expect(url.searchParams.get("timespan")).toBe("2026-09-01T00:00:00.000Z/2026-09-20T13:00:00.000Z");
      expect(url.searchParams.get("aggregation")).toBe("Total");
      return Response.json({ value: [{ name: { value: "Network In Total" }, timeseries: [{ data: [{ total: 50 }, { total: 150 }] }] }, { name: { value: "Network Out Total" }, timeseries: [{ data: [{ total: 300 }] }] }] });
    } });
    expect(await adapter.monthlyTraffic({ ...ref, service: "azure_vm", region: "eastus", instanceId: id }, now)).toMatchObject({ incomingBytes: 200, outgoingBytes: 300, totalBytes: 500, allowance: null, source: "azure_monitor" });
  });

  it("reads Linode public monthly traffic and keeps quota separate from pooled remaining", async () => {
    const adapter = new LinodeCloudAdapter("account", { kind: "linode_token", token: "secret" }, { fetch: async input => {
      const path = new URL(String(input)).pathname;
      const body = path === "/v4/linode/instances/42/transfer/2026/9" ? { bytes_in: 100, bytes_out: 300, bytes_total: 400 }
        : path === "/v4/linode/instances/42/transfer" ? { used: 300, quota: 1000, billable: 0 } : null;
      expect(body).not.toBeNull();
      return Response.json(body, { headers: { "X-Customer-UUID": "customer" } });
    } });
    expect(await adapter.monthlyTraffic({ ...ref, service: "linode", region: "us-east", instanceId: "42" }, now)).toMatchObject({ incomingBytes: 100, outgoingBytes: 300, totalBytes: 400, allowance: { gigabytes: 1000, scope: "account_pool" }, source: "linode" });
  });

  it("keeps Linode traffic available when optional quota permission is missing", async () => {
    const adapter = new LinodeCloudAdapter("account", { kind: "linode_token", token: "secret" }, { fetch: async input => String(input).endsWith("/transfer")
      ? Response.json({}, { status: 403 })
      : Response.json({ bytes_in: 0, bytes_out: 0, bytes_total: 0 }, { headers: { "X-Customer-UUID": "customer" } }) });
    expect(await adapter.monthlyTraffic({ ...ref, service: "linode", region: "us-east", instanceId: "42" }, now)).toMatchObject({ totalBytes: 0, allowance: null });
  });

  it("rejects a cross-account reference before querying metrics", async () => {
    const adapter = new Ec2CloudAdapter("account", aws, { cloudwatchSend: async () => { throw new Error("must not query"); } });
    await expect(adapter.monthlyTraffic({ ...ref, accountId: "other" }, now)).rejects.toMatchObject({ code: "resource_not_found" });
  });
});
