import {
  DescribeInstancesCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRegionsCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { CloudRef, CloudStep, SlotRef } from "@masterdns/contracts";

import { awsClientOptions, createAwsCredentialSource } from "./aws-credentials.js";
import { evaluateCapabilities } from "./capabilities.js";
import { decodeCursor, encodeCursor, mapEc2Instance } from "./discovery.js";
import { executeEc2Rotation, observeEc2Rotation } from "./ec2-rotation.js";
import { CloudError, normalizeAwsError } from "./errors.js";
import type { AwsAdapterDependencies, AwsCredentials, AwsSend, Capability, CloudAdapter, CloudInventory, CloudPage, CloudStepResult, CloudObservation } from "./provider.js";

export class Ec2CloudAdapter implements CloudAdapter {
  private readonly credentialSource: ReturnType<typeof createAwsCredentialSource>;
  private readonly stsClient: STSClient;
  private readonly ec2Clients = new Map<string, EC2Client>();

  constructor(
    private readonly accountId: string,
    credentials: AwsCredentials,
    private readonly dependencies: AwsAdapterDependencies = {},
  ) {
    this.credentialSource = createAwsCredentialSource(credentials);
    this.stsClient = new STSClient({ ...awsClientOptions, region: "us-east-1", credentials: this.credentialSource });
  }

  private stsSend(command: GetCallerIdentityCommand) {
    return this.dependencies.stsSend?.(command)
      ?? this.stsClient.send(command);
  }

  private ec2Send(region: string, command: Parameters<AwsSend>[0]) {
    if (this.dependencies.ec2Send !== undefined) return this.dependencies.ec2Send(command);
    let client = this.ec2Clients.get(region);
    if (client === undefined) {
      client = new EC2Client({ ...awsClientOptions, region, credentials: this.credentialSource });
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
