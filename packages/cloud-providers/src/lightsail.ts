import {
  GetInstanceCommand,
  GetInstancesCommand,
  GetRegionsCommand,
  GetStaticIpsCommand,
  LightsailClient,
} from "@aws-sdk/client-lightsail";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { CloudRef, CloudStep, SlotRef } from "@masterdns/contracts";

import { createAwsCredentialSource } from "./aws-credentials.js";
import { evaluateCapabilities } from "./capabilities.js";
import { decodeCursor, encodeCursor, mapLightsailInstance } from "./discovery.js";
import { CloudError, normalizeAwsError } from "./errors.js";
import type { AwsAdapterDependencies, AwsCredentials, AwsSend, Capability, CloudAdapter, CloudInventory, CloudPage } from "./provider.js";

export class LightsailCloudAdapter implements CloudAdapter {
  constructor(
    private readonly accountId: string,
    private readonly credentials: AwsCredentials,
    private readonly dependencies: AwsAdapterDependencies = {},
  ) {}

  private stsSend(command: GetCallerIdentityCommand) {
    return this.dependencies.stsSend?.(command)
      ?? new STSClient({ region: "us-east-1", credentials: createAwsCredentialSource(this.credentials) }).send(command);
  }

  private lightsailSend(region: string, command: GetRegionsCommand | GetInstancesCommand | GetInstanceCommand | GetStaticIpsCommand) {
    if (this.dependencies.lightsailSend !== undefined) return this.dependencies.lightsailSend(command);
    const client = new LightsailClient({ region, credentials: createAwsCredentialSource(this.credentials) });
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
      const response = await this.lightsailSend("us-east-1", new GetRegionsCommand({ includeAvailabilityZones: false }));
      return (response.regions ?? []).flatMap((region: { name?: string }) => region.name === undefined ? [] : [region.name]).sort();
    } catch (error) {
      throw normalizeAwsError(error);
    }
  }

  async discover(region: string, cursor?: string): Promise<CloudPage> {
    let pageToken: string | undefined;
    try {
      pageToken = decodeCursor("lightsail", cursor);
    } catch {
      throw new CloudError("invalid_cursor", false);
    }
    try {
      const [instances, staticIps] = await Promise.all([
        this.lightsailSend(region, new GetInstancesCommand({ pageToken })),
        this.lightsailSend(region, new GetStaticIpsCommand({})),
      ]);
      const items = (instances.instances ?? []).flatMap((instance: any) => {
        const mapped = mapLightsailInstance(this.accountId, region, instance, staticIps.staticIps ?? []);
        return mapped === undefined ? [] : [mapped];
      });
      const result: CloudPage = { items };
      const nextCursor = encodeCursor("lightsail", instances.nextPageToken);
      if (nextCursor !== undefined) result.cursor = nextCursor;
      return result;
    } catch (error) {
      throw normalizeAwsError(error);
    }
  }

  private async findNameByArn(region: string, arn: string): Promise<string> {
    let pageToken: string | undefined;
    do {
      const response = await this.lightsailSend(region, new GetInstancesCommand({ pageToken }));
      const instance = response.instances?.find((candidate: { arn?: string }) => candidate.arn === arn);
      if (instance?.name !== undefined) return instance.name;
      pageToken = response.nextPageToken;
    } while (pageToken !== undefined);
    throw new CloudError("resource_not_found", false);
  }

  async inspect(ref: CloudRef): Promise<CloudInventory> {
    if (ref.accountId !== this.accountId || ref.service !== "lightsail") throw new CloudError("resource_not_found", false);
    try {
      const nativeName = await this.findNameByArn(ref.region, ref.instanceId);
      const [instanceResponse, staticIpResponse] = await Promise.all([
        this.lightsailSend(ref.region, new GetInstanceCommand({ instanceName: nativeName })),
        this.lightsailSend(ref.region, new GetStaticIpsCommand({})),
      ]);
      if (instanceResponse.instance?.arn !== ref.instanceId) throw new CloudError("remote_identity_changed", false);
      const inventory = mapLightsailInstance(this.accountId, ref.region, instanceResponse.instance, staticIpResponse.staticIps ?? []);
      if (inventory === undefined) throw new CloudError("resource_not_found", false);
      return inventory;
    } catch (error) {
      throw normalizeAwsError(error);
    }
  }

  capabilities(slot: SlotRef, inventory: CloudInventory): Capability {
    return evaluateCapabilities(slot, inventory);
  }

  async execute(_step: CloudStep): Promise<{ remoteId?: string }> {
    throw new CloudError("cloud_writes_not_enabled", false);
  }

  async observe(_step: CloudStep): Promise<"pending" | "applied" | "not_applied" | "ambiguous"> {
    throw new CloudError("cloud_writes_not_enabled", false);
  }
}
