import {
  GetInstanceCommand,
  GetInstancesCommand,
  GetRegionsCommand,
  GetStaticIpCommand,
  GetStaticIpsCommand,
  LightsailClient,
} from "@aws-sdk/client-lightsail";
import type { StaticIp } from "@aws-sdk/client-lightsail";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { CloudRef, CloudStep, SlotRef } from "@masterdns/contracts";

import { awsClientOptions, createAwsCredentialSource } from "./aws-credentials.js";
import { evaluateCapabilities } from "./capabilities.js";
import { decodeCursor, encodeCursor, mapLightsailInstance } from "./discovery.js";
import { executeLightsailRotation, observeLightsailRotation } from "./lightsail-rotation.js";
import { CloudError, normalizeAwsError } from "./errors.js";
import type { AwsAdapterDependencies, AwsCredentials, AwsSend, Capability, CloudAdapter, CloudInventory, CloudPage, CloudStepResult, CloudObservation } from "./provider.js";

type ScopedOriginal =
  | { kind: "dynamic"; address: string }
  | { kind: "static"; name: string; address: string; resourceId?: string };

export type LightsailInspectionScope = {
  mode: "initial" | "transition";
  instanceName: string;
  original: ScopedOriginal;
  candidate?: { name: string; address: string; resourceId: string };
  allowDetachedOriginal?: boolean;
  allowCandidateAttached?: boolean;
};

export class LightsailCloudAdapter implements CloudAdapter {
  private readonly credentialSource: ReturnType<typeof createAwsCredentialSource>;
  private readonly stsClient: STSClient;
  private readonly lightsailClients = new Map<string, LightsailClient>();

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

  private lightsailSend(region: string, command: Parameters<AwsSend>[0]) {
    if (this.dependencies.lightsailSend !== undefined) return this.dependencies.lightsailSend(command);
    let client = this.lightsailClients.get(region);
    if (client === undefined) {
      client = new LightsailClient({ ...awsClientOptions, region, credentials: this.credentialSource });
      this.lightsailClients.set(region, client);
    }
    return (client.send.bind(client) as AwsSend)(command);
  }

  private async listStaticIps(region: string): Promise<StaticIp[]> {
    const staticIps: StaticIp[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.lightsailSend(region, new GetStaticIpsCommand({ pageToken }));
      staticIps.push(...response.staticIps ?? []);
      pageToken = response.nextPageToken;
    } while (pageToken !== undefined);
    return staticIps;
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
        this.listStaticIps(region),
      ]);
      const items = (instances.instances ?? []).flatMap((instance: any) => {
        const mapped = mapLightsailInstance(this.accountId, region, instance, staticIps);
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
        this.listStaticIps(ref.region),
      ]);
      if (instanceResponse.instance?.arn !== ref.instanceId) throw new CloudError("remote_identity_changed", false);
      const inventory = mapLightsailInstance(this.accountId, ref.region, instanceResponse.instance, staticIpResponse);
      if (inventory === undefined) throw new CloudError("resource_not_found", false);
      return inventory;
    } catch (error) {
      throw normalizeAwsError(error);
    }
  }

  async inspectScoped(ref: CloudRef, scope: LightsailInspectionScope): Promise<CloudInventory> {
    if (ref.accountId !== this.accountId || ref.service !== "lightsail") throw new CloudError("resource_not_found", false);
    try {
      const instanceResponse = await this.lightsailSend(ref.region, new GetInstanceCommand({ instanceName: scope.instanceName }));
      const instance = instanceResponse.instance;
      if (!instance || instance.name !== scope.instanceName || instance.arn !== ref.instanceId) throw new CloudError("remote_identity_changed", false);
      let staticIps: StaticIp[] = [];
      let originalStatic: StaticIp | undefined;
      if (scope.original.kind === "static") {
        const response = await this.lightsailSend(ref.region, new GetStaticIpCommand({ staticIpName: scope.original.name }));
        originalStatic = response.staticIp as StaticIp | undefined;
        if (!originalStatic || !originalStatic.arn || !sameLightsailIdentity(instance.arn, originalStatic.arn, "StaticIp")
          || originalStatic.name !== scope.original.name || originalStatic.ipAddress !== scope.original.address
          || (scope.original.resourceId !== undefined && originalStatic.arn !== scope.original.resourceId)
          || (originalStatic.attachedTo !== undefined && originalStatic.attachedTo !== scope.instanceName)) throw new CloudError("remote_identity_changed", false);
        staticIps.push(originalStatic);
      }
      let candidateStatic: StaticIp | undefined;
      if (scope.candidate !== undefined) {
        const response = await this.lightsailSend(ref.region, new GetStaticIpCommand({ staticIpName: scope.candidate.name }));
        candidateStatic = response.staticIp as StaticIp | undefined;
        if (!candidateStatic || !candidateStatic.arn || !sameLightsailIdentity(instance.arn, candidateStatic.arn, "StaticIp")
          || candidateStatic.name !== scope.candidate.name || candidateStatic.arn !== scope.candidate.resourceId
          || candidateStatic.ipAddress !== scope.candidate.address
          || (candidateStatic.attachedTo !== undefined && candidateStatic.attachedTo !== scope.instanceName)) throw new CloudError("remote_identity_changed", false);
        staticIps.push(candidateStatic);
      }

      const originalActive = scope.original.kind === "static" && originalStatic?.attachedTo === scope.instanceName
        && instance.isStaticIp === true && instance.publicIpAddress === scope.original.address && candidateStatic?.attachedTo === undefined;
      const originalDynamic = scope.original.kind === "dynamic" && instance.isStaticIp === false
        && instance.publicIpAddress === scope.original.address && candidateStatic?.attachedTo === undefined;
      const detachedOriginal = scope.mode === "transition" && scope.allowDetachedOriginal === true && scope.original.kind === "static"
        && originalStatic?.attachedTo === undefined && instance.isStaticIp === false && candidateStatic?.attachedTo === undefined;
      const candidateActive = scope.mode === "transition" && scope.allowCandidateAttached === true && candidateStatic?.attachedTo === scope.instanceName
        && instance.isStaticIp === true && instance.publicIpAddress === scope.candidate?.address
        && (scope.original.kind === "dynamic" || originalStatic?.attachedTo === undefined);
      if (!originalActive && !originalDynamic && !detachedOriginal && !candidateActive) throw new CloudError("remote_identity_changed", false);

      const inventory = mapLightsailInstance(this.accountId, ref.region, instance, staticIps);
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
      return await executeLightsailRotation(step, this.accountId, command => this.lightsailSend((step.arguments.slot as SlotRef)?.region, command));
    } catch (error) { throw normalizeAwsError(error); }
  }

  async observeDetails(step: CloudStep): Promise<CloudObservation> {
    try {
      return await observeLightsailRotation(step, this.accountId, command => this.lightsailSend((step.arguments.slot as SlotRef)?.region, command));
    } catch (error) { throw normalizeAwsError(error); }
  }

  async observe(step: CloudStep): Promise<"pending" | "applied" | "not_applied" | "ambiguous"> {
    return (await this.observeDetails(step)).status;
  }
}

function sameLightsailIdentity(instanceArn: string, resourceArn: string, resourceType: string): boolean {
  const instance = instanceArn.split(":");
  const resource = resourceArn.split(":");
  return instance.length === 6 && resource.length === 6 && instance.slice(0, 5).every((part, index) => part === resource[index])
    && resource[5]?.startsWith(`${resourceType}/`) === true;
}
