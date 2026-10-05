import { DescribeAddressesCommand, DescribeInstancesCommand, DescribeNetworkInterfacesCommand, DescribeRegionsCommand } from "@aws-sdk/client-ec2";
import { GetInstanceCommand, GetInstancesCommand, GetOperationCommand, GetRegionsCommand, GetStaticIpCommand, GetStaticIpsCommand } from "@aws-sdk/client-lightsail";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { CloudRef, CloudStep, SlotRef } from "@masterdns/contracts";
import { fixture as azureFixture, credentials as azureCredentials, vmId, nicId, configId, pipId } from "./azure-fixtures.js";
import { createCloudAdapter } from "./factory.js";
import { CloudError } from "./errors.js";
import { CloudServiceRegistry } from "./service-registry.js";
import type { AwsSend, CloudInventory, CloudInventoryAdapter, CloudObservation, CloudProviderAdapter, CloudStepResult } from "./provider.js";

export type ObservationState = "pending" | "applied" | "ambiguous";

/** A fresh real adapter and an audited, read-only transport for each contract test. */
export type AdapterContractFixture = {
  adapter: CloudProviderAdapter;
  requests: string[];
  unexpectedRequests: string[];
  registry?: CloudServiceRegistry;
  reconnect?: () => CloudProviderAdapter;
  prepareObservation?: (plan: CloudStep[], state: ObservationState) => CloudStep;
};
export type AdapterContractCase = {
  name?: string;
  service: CloudRef["service"];
  create: () => AdapterContractFixture;
  identity: string;
  scopes: string[];
  inventory: CloudInventory;
  slot: SlotRef;
  foreignRefError: string;
  optional: { lifecycle: boolean; traffic: boolean; idleIps: boolean };
  rotation: false | { detailedObservation: boolean; actions: string[]; observations: Array<{ state: ObservationState; expected: Partial<CloudObservation> }> };
};
const awsCredentials = { kind: "access_key" as const, accessKeyId: "contract-key", secretAccessKey: "contract-secret" };
const ec2Ref: CloudRef = { accountId: "account", service: "ec2", region: "us-east-1", instanceId: "i-0123456789abcdef0" };
const lightsailRef: CloudRef = { accountId: "account", service: "lightsail", region: "us-east-1", instanceId: "arn:aws:lightsail:us-east-1:123456789012:Instance/instance-guid" };
const azureRef: CloudRef = { accountId: "account", service: "azure_vm", region: "eastus", instanceId: vmId };
const linodeRef: CloudRef = { accountId: "account", service: "linode", region: "us-east", instanceId: "42" };

function persistedStep(step: CloudStep, receipt: CloudStepResult): CloudStep {
  return { ...structuredClone(step), arguments: { ...structuredClone(step.arguments), previousExecution: true, receipt } };
}

function awsFixture(service: "ec2" | "lightsail"): AdapterContractFixture {
  const requests: string[] = [], unexpectedRequests: string[] = [];
  let observationState: ObservationState | undefined;
  const networkInterface = { NetworkInterfaceId: "eni-one", Attachment: { DeviceIndex: 0, InstanceId: ec2Ref.instanceId }, PrivateIpAddresses: [{ PrivateIpAddress: "10.0.0.4", Primary: true, Association: { PublicIp: "198.51.100.4", AllocationId: "eipalloc-one" } }], Ipv6Addresses: [{ Ipv6Address: "2001:db8::4", IsPrimaryIpv6: true }] };
  const ec2Instance = { InstanceId: ec2Ref.instanceId, Tags: [{ Key: "Name", Value: "edge-ec2" }], State: { Name: "running" }, NetworkInterfaces: [networkInterface] };
  const lightsailInstance = { arn: lightsailRef.instanceId, name: "edge-lightsail", state: { name: "running" }, privateIpAddress: "10.0.0.5", publicIpAddress: "198.51.100.5", ipv6Addresses: ["2001:db8::5"], ipAddressType: "dualstack" };
  const send: AwsSend = async command => {
    requests.push(command.constructor.name);
    if (command instanceof GetCallerIdentityCommand) return { Account: "123456789012" };
    if (command instanceof DescribeRegionsCommand) return { Regions: [{ RegionName: "us-west-2" }, { RegionName: "ap-east-1", OptInStatus: "not-opted-in" }, { RegionName: "us-east-1" }] };
    if (command instanceof DescribeInstancesCommand) return { Reservations: [{ Instances: [ec2Instance] }] };
    if (command instanceof DescribeAddressesCommand && observationState) return { Addresses: observationState === "pending" ? [] : [{
      AllocationId: observationState === "ambiguous" ? "eipalloc-unrelated" : "eipalloc-candidate", PublicIp: "198.51.100.99",
      Tags: [{ Key: "masterdns:attempt", Value: "contract-attempt" }, { Key: "masterdns:account", Value: "account" }, { Key: "masterdns:instance", Value: ec2Ref.instanceId }, { Key: "masterdns:slot", Value: "slot" }],
    }] };
    if (command instanceof GetOperationCommand && observationState) return { operation: { id: "operation-one", resourceName: "masterdns-contract-attempt", status: observationState === "pending" ? "Started" : "Succeeded" } };
    if (command instanceof GetStaticIpCommand && observationState) return { staticIp: {
      name: "masterdns-contract-attempt", ipAddress: "198.51.100.99", isAttached: false,
      arn: `arn:aws:lightsail:us-east-1:123456789012:StaticIp/${observationState === "ambiguous" ? "unrelated" : "candidate"}-guid`,
    } };
    if (command instanceof DescribeNetworkInterfacesCommand) return { NetworkInterfaces: [networkInterface] };
    if (command instanceof GetRegionsCommand) return { regions: [{ name: "us-west-2" }, { name: "us-east-1" }] };
    if (command instanceof GetInstancesCommand) return { instances: [lightsailInstance] };
    if (command instanceof GetInstanceCommand) return { instance: lightsailInstance };
    if (command instanceof GetStaticIpsCommand) return { staticIps: [{ name: "static-one", arn: "arn:aws:lightsail:us-east-1:123456789012:StaticIp/static-guid", attachedTo: "edge-lightsail", ipAddress: "198.51.100.5" }] };
    unexpectedRequests.push(command.constructor.name);
    throw new Error(`Unexpected contract SDK command: ${command.constructor.name}`);
  };
  const reconnect = () => createCloudAdapter({ accountId: "account", service, credentials: awsCredentials }, { stsSend: send, ec2Send: send, lightsailSend: send, cloudwatchSend: send });
  return { adapter: reconnect(), requests, unexpectedRequests, reconnect,
    prepareObservation: (plan, state) => {
      observationState = state;
      return persistedStep(plan[0]!, service === "ec2"
        ? { allocationId: "eipalloc-candidate", candidateAddress: "198.51.100.99" }
        : { allocationId: "masterdns-contract-attempt", resourceId: "arn:aws:lightsail:us-east-1:123456789012:StaticIp/candidate-guid", candidateAddress: "198.51.100.99", operationId: "operation-one" });
    },
  };
}

function azureReadFixture(): AdapterContractFixture {
  const fixture = azureFixture();
  const requests: string[] = [], unexpectedRequests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    const request = `${method} ${url.origin}${url.pathname}`;
    requests.push(request);
    // Obtaining an OAuth token is not a cloud-resource mutation.
    if (method !== "GET" && !(method === "POST" && url.hostname === "login.microsoftonline.com")) {
      unexpectedRequests.push(request);
      throw new Error(`Unexpected contract HTTP mutation: ${request}`);
    }
    if (url.pathname === "/subscriptions/subscription-1/providers/Microsoft.Compute/virtualMachines") fixture.setPages([{ value: [fixture.resources[vmId]] }]);
    return fixture.fetcher(input, init);
  };
  const reconnect = () => createCloudAdapter({ accountId: "account", service: "azure_vm", credentials: azureCredentials }, { fetch: fetcher });
  return { adapter: reconnect(), requests, unexpectedRequests, reconnect,
    prepareObservation: (plan, state) => {
      const step = plan[0]!, id = String(step.arguments.azureCandidateId);
      const candidate = structuredClone(fixture.resources[pipId]);
      candidate.id = id;
      candidate.name = id.split("/").at(-1);
      candidate.tags = { "masterdns-attempt": state === "ambiguous" ? "another-attempt" : "contract-attempt", "masterdns-account": "account", "masterdns-slot": "slot" };
      candidate.properties.ipAddress = "20.30.40.51";
      candidate.properties.resourceGuid = "candidate-resource-generation";
      candidate.properties.provisioningState = state === "pending" ? "Creating" : "Succeeded";
      delete candidate.properties.ipConfiguration;
      fixture.resources[id] = candidate;
      return persistedStep(step, { allocationId: id, resourceId: id });
    },
  };
}

function linodeReadFixture(): AdapterContractFixture {
  const requests: string[] = [], unexpectedRequests: string[] = [];
  let observationState: ObservationState | undefined;
  const ip = (address: string) => ({ address, type: "ipv4", public: true, linode_id: 42, region: "us-east" });
  const instance = { id: 42, label: "edge-linode", region: "us-east", status: "running", interface_generation: "legacy_config" };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET";
    const request = `${method} ${url.origin}${url.pathname}`;
    requests.push(request);
    const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "X-Customer-UUID": "customer-uuid", "X-OAuth-Scopes": "linodes:read_write ips:read_only events:read_only" } });
    const page = (data: unknown[]) => response({ data, page: 1, pages: 1, results: data.length });
    if (url.origin === "https://api.linode.com" && method === "GET") {
      switch (url.pathname) {
        case "/v4/profile": return response({ username: "reader-not-account-id" });
        case "/v4/regions": return page([{ id: "us-east" }, { id: "ap-south" }]);
        case "/v4/linode/instances": return page([instance]);
        case "/v4/linode/instances/42": return response(instance);
        case "/v4/linode/instances/42/configs": return page([{ id: 7, helpers: { network: true }, interfaces: [], run_level: "default" }]);
        case "/v4/account/events": return page(observationState ? [{ id: 1, action: "linode_reboot", entity: { type: "linode", id: 42 }, username: observationState === "ambiguous" ? "another-actor" : "reader-not-account-id", status: observationState === "pending" ? "started" : "finished" }] : []);
        case "/v4/networking/ips/203.0.113.20": if (observationState) return response(ip("203.0.113.20")); break;
        case "/v4/linode/instances/42/ips": return response({ ipv4: { public: (observationState ? ["203.0.113.10", "203.0.113.20"] : ["203.0.113.10"]).map(ip), shared: [], reserved: [] }, ipv6: { slaac: { address: "2600:3c00::abcd/128", linode_id: 42, region: "us-east" }, global: [] } });
      }
    }
    unexpectedRequests.push(request);
    throw new Error(`Unexpected contract HTTP request: ${request}`);
  };
  const reconnect = () => createCloudAdapter({ accountId: "account", service: "linode", credentials: { kind: "linode_token", token: "contract-token" } }, { fetch: fetcher });
  return { adapter: reconnect(), requests, unexpectedRequests, reconnect,
    prepareObservation: (plan, state) => {
      observationState = state;
      const step = persistedStep(plan[1]!, { operationId: "1", before: { eventWatermark: 0 } });
      step.arguments.candidateReceipt = {
        candidateAddress: "203.0.113.20", allocationId: "203.0.113.20", resourceId: "/linode/instances/42/ips/203.0.113.20",
        before: { ipv4: ["203.0.113.10"], eventWatermark: 0 },
        after: { externalAccountId: "customer-uuid", instanceId: "42", region: "us-east", configId: 7, attemptId: "contract-attempt" },
      };
      return step;
    },
  };
}

function observationExpectations(candidateAddress: string): Array<{ state: ObservationState; expected: Partial<CloudObservation> }> {
  return [
    { state: "pending", expected: { status: "pending" } },
    { state: "applied", expected: { status: "applied", candidateAddress } },
    { state: "ambiguous", expected: { status: "ambiguous" } },
  ];
}

// Expectations are literal domain values, never generated with adapter mapping helpers.
export const adapterContractCases: AdapterContractCase[] = [
  {
    service: "ec2", create: () => awsFixture("ec2"), identity: "123456789012", scopes: ["us-east-1", "us-west-2"],
    inventory: { ref: ec2Ref, name: "edge-ec2", state: "running", interfaces: [{ id: "eni-one", deviceIndex: 0, addresses: [
      { address: "10.0.0.4", family: 4, primary: true },
      { address: "198.51.100.4", family: 4, primary: true, allocationId: "eipalloc-one", privateAddress: "10.0.0.4" },
      { address: "2001:db8::4", family: 6, primary: true },
    ] }] },
    slot: { ...ec2Ref, interfaceId: "eni-one", slotId: "slot", family: 4, address: "198.51.100.4" },
    foreignRefError: "resource_not_found", optional: { lifecycle: true, traffic: true, idleIps: false }, rotation: { detailedObservation: true, actions: ["ec2.eip.allocate", "ec2.eip.associate"], observations: observationExpectations("198.51.100.99") },
  },
  {
    service: "lightsail", create: () => awsFixture("lightsail"), identity: "123456789012", scopes: ["us-east-1", "us-west-2"],
    inventory: { ref: lightsailRef, nativeName: "edge-lightsail", name: "edge-lightsail", state: "running", ipv6Only: false, interfaces: [{ id: "primary", addresses: [
      { address: "10.0.0.5", family: 4, primary: true },
      { address: "198.51.100.5", family: 4, primary: true, allocationId: "static-one", resourceId: "arn:aws:lightsail:us-east-1:123456789012:StaticIp/static-guid" },
      { address: "2001:db8::5", family: 6, primary: true },
    ] }] },
    slot: { ...lightsailRef, interfaceId: "primary", slotId: "slot", family: 4, address: "198.51.100.5" },
    foreignRefError: "resource_not_found", optional: { lifecycle: true, traffic: true, idleIps: true }, rotation: { detailedObservation: true, actions: ["lightsail.static-ip.allocate", "lightsail.static-ip.detach", "lightsail.static-ip.attach"], observations: observationExpectations("198.51.100.99") },
  },
  {
    service: "azure_vm", create: azureReadFixture, identity: "subscription-1", scopes: ["eastus", "westus"],
    inventory: { ref: azureRef, nativeName: "vm", name: "vm", state: "running", interfaces: [
      { id: configId, addresses: [{ address: "20.30.40.50", family: 4, primary: true, allocationId: pipId, resourceId: pipId, privateAddress: "10.0.0.5" }] },
      { id: `${nicId}/ipConfigurations/sibling`, addresses: [] },
    ] },
    slot: { ...azureRef, interfaceId: configId, slotId: "slot", family: 4, address: "20.30.40.50" },
    foreignRefError: "resource_ownership_ambiguous", optional: { lifecycle: true, traffic: true, idleIps: false }, rotation: { detailedObservation: true, actions: ["azure.public-ip.allocate", "azure.public-ip.associate"], observations: observationExpectations("20.30.40.51") },
  },
  {
    service: "linode", create: linodeReadFixture, identity: "customer-uuid", scopes: ["us-east", "ap-south"],
    inventory: { ref: linodeRef, name: "edge-linode", state: "running", interfaces: [{ id: "public", deviceIndex: 0, addresses: [
      { address: "203.0.113.10", family: 4, primary: true, allocationId: "203.0.113.10", resourceId: "/linode/instances/42/ips/203.0.113.10" },
      { address: "2600:3c00::abcd", family: 6, primary: true },
    ] }] },
    slot: { ...linodeRef, interfaceId: "public", slotId: "slot", family: 4, address: "203.0.113.10" },
    foreignRefError: "remote_identity_changed", optional: { lifecycle: true, traffic: true, idleIps: false }, rotation: { detailedObservation: true, actions: ["linode.ipv4.allocate", "linode.instance.reboot"], observations: observationExpectations("203.0.113.20") },
  },
];


/** An actual minimal implementation: no execute, observe, lifecycle or traffic stubs. */
type InventoryOnlySource = { externalAccountId: string; scopes: string[]; inventory: CloudInventory };
class InventoryOnlyAdapter implements CloudInventoryAdapter {
  constructor(private readonly read: (path: "identity" | "scopes" | "inventory") => Promise<InventoryOnlySource>) {}
  async verifyIdentity() { return { externalAccountId: (await this.read("identity")).externalAccountId }; }
  async listScopes() { return (await this.read("scopes")).scopes; }
  async discover() { return { items: [(await this.read("inventory")).inventory] }; }
  async inspect(ref: CloudRef) {
    if (ref.accountId !== "account" || ref.service !== "ec2") throw new CloudError("resource_not_found", false);
    return (await this.read("inventory")).inventory;
  }
}
const readOnlyInventory: CloudInventory = {
  ref: ec2Ref, name: "inventory-only", state: "running",
  interfaces: [{ id: "eni-read-only", addresses: [{ address: "192.0.2.1", family: 4, primary: true }] }],
};
adapterContractCases.push({
  name: "inventory-only", service: "ec2", identity: "read-only-account", scopes: ["us-east-1"], inventory: readOnlyInventory,
  slot: { ...ec2Ref, interfaceId: "eni-read-only", slotId: "slot", family: 4, address: "192.0.2.1" },
  foreignRefError: "resource_not_found", optional: { lifecycle: false, traffic: false, idleIps: false }, rotation: false,
  create: () => {
    const requests: string[] = [];
    const registry = new CloudServiceRegistry([{ service: "ec2", provider: "aws", createAdapter: () => new InventoryOnlyAdapter(async path => {
      requests.push(path);
      return structuredClone({ externalAccountId: "read-only-account", scopes: ["us-east-1"], inventory: readOnlyInventory });
    }) }]);
    return { adapter: registry.createAdapter({ accountId: "account", service: "ec2", credentials: awsCredentials }), requests, unexpectedRequests: [], registry };
  },
});
