import {
  DescribeInstancesCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRegionsCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { monthPeriod, monthlyTrafficResult, sumTraffic } from "./monthly-traffic.js";
import type { CloudLifecycleAction, CloudLifecycleReceipt, CloudLifecycleSnapshot, CloudPowerState, CloudRef, CloudStep, SlotRef } from "@masterdns/contracts";

import { createAwsClientOptions, createAwsCredentialSource } from "./aws-credentials.js";
import { evaluateCapabilities } from "./capabilities.js";
import { decodeCursor, encodeCursor, mapEc2Instance } from "./discovery.js";
import { executeEc2Rotation, observeEc2Rotation } from "./ec2-rotation.js";
import { CloudError, normalizeAwsError } from "./errors.js";
import { assertLifecycleAction, assertLifecycleSnapshot, lifecycleNoWrite, sameLifecycleRef } from "./lifecycle.js";
import type { AwsAdapterDependencies, AwsCredentials, AwsSend, Capability, CloudAdapter, CloudInventory, CloudPage, CloudStepResult, CloudObservation } from "./provider.js";

export class Ec2CloudAdapter implements CloudAdapter {
  private readonly credentialSource: ReturnType<typeof createAwsCredentialSource>;
  private readonly clientOptions: ReturnType<typeof createAwsClientOptions>;
  private readonly stsClient: STSClient;
  private readonly ec2Clients = new Map<string, EC2Client>();

  constructor(
    private readonly accountId: string,
    credentials: AwsCredentials,
    private readonly dependencies: AwsAdapterDependencies = {},
  ) {
    this.clientOptions = createAwsClientOptions(credentials.proxyUrl);
    this.credentialSource = createAwsCredentialSource(credentials, this.clientOptions);
    this.stsClient = new STSClient({ ...this.clientOptions, region: "us-east-1", credentials: this.credentialSource });
  }

  private stsSend(command: GetCallerIdentityCommand) {
    return this.dependencies.stsSend?.(command)
      ?? this.stsClient.send(command);
  }

  private ec2Send(region: string, command: Parameters<AwsSend>[0]) {
    if (this.dependencies.ec2Send !== undefined) return this.dependencies.ec2Send(command);
    let client = this.ec2Clients.get(region);
    if (client === undefined) {
      client = new EC2Client({ ...this.clientOptions, region, credentials: this.credentialSource });
      this.ec2Clients.set(region, client);
    }
    return (client.send.bind(client) as AwsSend)(command);
  }

  async verifyIdentity(): Promise<{ externalAccountId: string }> {
    try {
      const response = await this.stsSend(new GetCallerIdentityCommand({}));
      if (response.Account === undefined) throw new CloudError("invalid_credentials", false);
      return { externalAccountId: response.Account };
    } catch (error) {
      throw normalizeAwsError(error);
    }
  }

  async listScopes(): Promise<string[]> {
    try {
      const response = await this.ec2Send("us-east-1", new DescribeRegionsCommand({ AllRegions: true }));
      return (response.Regions ?? [])
        .filter((region: { OptInStatus?: string }) => region.OptInStatus !== "not-opted-in")
        .flatMap((region: { RegionName?: string }) => region.RegionName === undefined ? [] : [region.RegionName])
        .sort();
    } catch (error) {
      throw normalizeAwsError(error);
    }
  }

  async discover(region: string, cursor?: string): Promise<CloudPage> {
    let nextToken: string | undefined;
    try {
      nextToken = decodeCursor("ec2", cursor);
    } catch {
      throw new CloudError("invalid_cursor", false);
    }
    try {
      const response = await this.ec2Send(region, new DescribeInstancesCommand({ NextToken: nextToken }));
      const items = (response.Reservations ?? []).flatMap((reservation: { Instances?: any[] }) => reservation.Instances ?? [])
        .flatMap((instance: any) => {
          const mapped = mapEc2Instance(this.accountId, region, instance);
          return mapped === undefined ? [] : [mapped];
        });
      const result: CloudPage = { items };
      const nextCursor = encodeCursor("ec2", response.NextToken);
      if (nextCursor !== undefined) result.cursor = nextCursor;
      return result;
    } catch (error) {
      throw normalizeAwsError(error);
    }
  }

  async inspect(ref: CloudRef): Promise<CloudInventory> {
    if (ref.accountId !== this.accountId || ref.service !== "ec2") throw new CloudError("resource_not_found", false);
    try {
      const instanceResponse = await this.ec2Send(ref.region, new DescribeInstancesCommand({ InstanceIds: [ref.instanceId] }));
      const instance = instanceResponse.Reservations?.flatMap((reservation: { Instances?: any[] }) => reservation.Instances ?? [])[0];
      if (instance === undefined || instance.InstanceId !== ref.instanceId) throw new CloudError("resource_not_found", false);
      const interfaceResponse = await this.ec2Send(ref.region, new DescribeNetworkInterfacesCommand({
        Filters: [{ Name: "attachment.instance-id", Values: [ref.instanceId] }],
      }));
      const inventory = mapEc2Instance(this.accountId, ref.region, instance, interfaceResponse.NetworkInterfaces ?? []);
      if (inventory === undefined) throw new CloudError("resource_not_found", false);
      return inventory;
    } catch (error) {
      throw normalizeAwsError(error);
    }
  }

  async inspectLifecycle(ref: CloudRef): Promise<CloudLifecycleSnapshot> {
    validateEc2LifecycleRef(ref, this.accountId);
    let response: any;
    try {
      response = await this.ec2Send(ref.region, new DescribeInstancesCommand({ InstanceIds: [ref.instanceId] }));
    } catch (error) {
      const normalized = normalizeAwsError(error);
      if (normalized.code === "resource_not_found") return { ref, identity: ref.instanceId, state: "deleted" };
      throw normalized;
    }
    const instances = (response.Reservations ?? []).flatMap((reservation: { Instances?: any[] }) => reservation.Instances ?? []);
    if (instances.length !== 1 || instances[0]?.InstanceId !== ref.instanceId) throw new CloudError("remote_identity_changed", false);
    const instance = instances[0];
    const nativeName = instance.Tags?.find((tag: { Key?: string; Value?: string }) => tag.Key === "Name")?.Value;
    return { ref, identity: ref.instanceId, state: ec2LifecycleState(instance.State?.Name),
      ...(typeof nativeName === "string" && nativeName.length > 0 ? { nativeName } : {}),
    };
  }

  async mutateLifecycle(action: CloudLifecycleAction, snapshot: CloudLifecycleSnapshot): Promise<CloudLifecycleReceipt> {
    assertLifecycleAction(action);
    assertLifecycleSnapshot(snapshot, this.accountId, "ec2");
    validateEc2LifecycleRef(snapshot.ref, this.accountId);
    if (snapshot.identity !== snapshot.ref.instanceId) throw new CloudError("remote_identity_changed", false);
    const current = await this.inspectLifecycle(snapshot.ref);
    if (!sameLifecycleRef(current.ref, snapshot.ref) || current.identity !== snapshot.identity) throw new CloudError("remote_identity_changed", false);
    const noWrite = lifecycleNoWrite(action, current.state);
    if (noWrite !== undefined) return noWrite;
    try {
      if (action === "start") await this.ec2Send(snapshot.ref.region, new StartInstancesCommand({ InstanceIds: [snapshot.ref.instanceId] }));
      else if (action === "stop") await this.ec2Send(snapshot.ref.region, new StopInstancesCommand({ InstanceIds: [snapshot.ref.instanceId], Force: false, Hibernate: false, SkipOsShutdown: false }));
      else await this.ec2Send(snapshot.ref.region, new TerminateInstancesCommand({ InstanceIds: [snapshot.ref.instanceId], Force: false, SkipOsShutdown: false }));
      return {};
    } catch (error) {
      throw normalizeAwsError(error);
    }
  }

  async monthlyTraffic(ref: CloudRef, now = new Date()) {
    if (ref.accountId !== this.accountId || ref.service !== "ec2") throw new CloudError("resource_not_found", false);
    const client = new CloudWatchClient({ ...this.clientOptions, region: ref.region, credentials: this.credentialSource });
    try {
      const period = monthPeriod(now);
      const read = async (MetricName: string) => {
        // At most 744 hourly samples: below GetMetricStatistics' 1,440-point limit,
        // and valid for the entire current month, including samples older than 15 days.
        const command = new GetMetricStatisticsCommand({ Namespace: "AWS/EC2", MetricName, Dimensions: [{ Name: "InstanceId", Value: ref.instanceId }], StartTime: period.start, EndTime: period.end, Period: 3600, Statistics: ["Sum"], Unit: "Bytes" });
        const result = await (this.dependencies.cloudwatchSend?.(command) ?? client.send(command));
        return sumTraffic((result.Datapoints ?? []).map((point: { Sum?: number }) => point.Sum));
      };
      const [incoming, outgoing] = await Promise.all([read("NetworkIn"), read("NetworkOut")]);
      return monthlyTrafficResult("cloudwatch", now, incoming, outgoing);
    } catch (error) { throw normalizeAwsError(error); }
    finally { client.destroy(); }
  }

  capabilities(slot: SlotRef, inventory: CloudInventory): Capability {
    return evaluateCapabilities(slot, inventory);
  }

  async execute(step: CloudStep): Promise<CloudStepResult> {
    try {
      return await executeEc2Rotation(step, this.accountId, command => this.ec2Send((step.arguments.slot as SlotRef)?.region, command));
    } catch (error) { throw normalizeAwsError(error); }
  }

  async observeDetails(step: CloudStep): Promise<CloudObservation> {
    try {
      return await observeEc2Rotation(step, this.accountId, command => this.ec2Send((step.arguments.slot as SlotRef)?.region, command));
    } catch (error) { throw normalizeAwsError(error); }
  }

  async observe(step: CloudStep): Promise<"pending" | "applied" | "not_applied" | "ambiguous"> {
    return (await this.observeDetails(step)).status;
  }
}

function validateEc2LifecycleRef(ref: CloudRef, accountId: string): void {
  if (ref.accountId !== accountId || ref.service !== "ec2" || !/^i-[0-9a-f]{8}(?:[0-9a-f]{9})?$/.test(ref.instanceId)
    || ref.region.length > 64 || !/^[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+$/.test(ref.region)) throw new CloudError("remote_identity_changed", false);
}

function ec2LifecycleState(value: unknown): CloudPowerState {
  if (value === "running") return "running";
  if (value === "stopped") return "stopped";
  if (value === "pending") return "starting";
  if (value === "stopping") return "stopping";
  if (value === "shutting-down") return "deleting";
  if (value === "terminated") return "deleted";
  return "unknown";
}
