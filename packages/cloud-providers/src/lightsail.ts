import { isIPv4 } from "node:net";
import {
  DeleteInstanceCommand,
  GetInstanceCommand,
  GetInstanceMetricDataCommand,
  GetInstancesCommand,
  GetRegionsCommand,
  GetStaticIpCommand,
  GetStaticIpsCommand,
  LightsailClient,
  ReleaseStaticIpCommand,
  StartInstanceCommand,
  StopInstanceCommand,
} from "@aws-sdk/client-lightsail";
import type { StaticIp } from "@aws-sdk/client-lightsail";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { CloudLifecycleAction, CloudLifecycleReceipt, CloudLifecycleSnapshot, CloudPowerState, CloudRef, CloudStep, SlotRef } from "@masterdns/contracts";

import { createAwsClientOptions, createAwsCredentialSource } from "./aws-credentials.js";
import { evaluateCapabilities } from "./capabilities.js";
import { decodeCursor, encodeCursor, mapLightsailInstance } from "./discovery.js";
import { executeLightsailRotation, observeLightsailRotation } from "./lightsail-rotation.js";
import { CloudError, normalizeAwsError } from "./errors.js";
import { assertLifecycleAction, assertLifecycleSnapshot, lifecycleNoWrite, operationIds, sameLifecycleRef } from "./lifecycle.js";
import { monthPeriod, monthlyTrafficResult, sumTraffic, trafficNumber } from "./monthly-traffic.js";
import type { AwsAdapterDependencies, AwsCredentials, AwsSend, Capability, CloudAdapter, CloudInventory, CloudPage, CloudStepResult, CloudObservation, IdleStaticIp, IdleStaticIpReleaseResult } from "./provider.js";

type ScopedOriginal =
  | { kind: "dynamic"; address: string }
  | { kind: "static"; name: string; address: string; resourceId?: string };

export type LightsailInspectionScope = {
  mode: "initial" | "transition";
  instanceName: string;
  selected: { family: 4 | 6; address: string };
  ipv4: ScopedOriginal;
  candidate?: { name: string; address: string; resourceId: string };
  allowDetachedOriginal?: boolean;
  allowCandidateAttached?: boolean;
  allowIpv6Absent?: boolean;
  allowIpv6Candidate?: boolean;
  ipv6Candidate?: string;
};

export class LightsailCloudAdapter implements CloudAdapter {
  private readonly credentialSource: ReturnType<typeof createAwsCredentialSource>;
  private readonly clientOptions: ReturnType<typeof createAwsClientOptions>;
  private readonly stsClient: STSClient;
  private readonly lightsailClients = new Map<string, LightsailClient>();

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

  private lightsailSend(region: string, command: Parameters<AwsSend>[0]) {
    if (this.dependencies.lightsailSend !== undefined) return this.dependencies.lightsailSend(command);
    let client = this.lightsailClients.get(region);
    if (client === undefined) {
      client = new LightsailClient({ ...this.clientOptions, region, credentials: this.credentialSource });
      this.lightsailClients.set(region, client);
    }
    return (client.send.bind(client) as AwsSend)(command);
  }

  private async listStaticIps(region: string): Promise<StaticIp[]> {
    const staticIps: StaticIp[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const response = await this.lightsailSend(region, new GetStaticIpsCommand({ pageToken }));
      staticIps.push(...response.staticIps ?? []);
      pageToken = response.nextPageToken;
      if (pageToken !== undefined) {
        if (seenTokens.has(pageToken)) throw new CloudError("invalid_cursor", false);
        seenTokens.add(pageToken);
      }
    } while (pageToken !== undefined);
    return staticIps;
  }

  async listIdleStaticIps(region: string): Promise<IdleStaticIp[]> {
    try {
      const { externalAccountId } = await this.verifyIdentity();
      return (await this.listStaticIps(region)).flatMap(staticIp => {
        if (staticIp.isAttached !== false || staticIp.attachedTo !== undefined) return [];
        const identity = staticIpIdentity(staticIp, region, externalAccountId);
        return identity === undefined ? [] : [identity];
      });
    } catch (error) { throw normalizeAwsError(error); }
  }

  async releaseIdleStaticIp(target: IdleStaticIp): Promise<IdleStaticIpReleaseResult> {
    const { externalAccountId } = await this.verifyIdentity();
    if (!validIdleStaticIpTarget(target, externalAccountId)) return { status: "skipped", reason: "remote_identity_changed" };

    let current: StaticIp | undefined;
    try {
      current = (await this.lightsailSend(target.region, new GetStaticIpCommand({ staticIpName: target.name }))).staticIp;
    } catch (error) {
      const normalized = normalizeAwsError(error);
      if (normalized.code === "resource_not_found") return { status: "missing" };
      throw normalized;
    }
    const reason = idleStaticIpChange(target, current, externalAccountId);
    if (reason !== undefined) return { status: "skipped", reason };

    let operationIds: string[] = [];
    let releaseError: CloudError | undefined;
    try {
      // The shared client options use one attempt: a lost mutation response must only be observed.
      const response = await this.lightsailSend(target.region, new ReleaseStaticIpCommand({ staticIpName: target.name }));
      operationIds = (response.operations ?? []).flatMap((operation: { id?: string }) =>
        typeof operation.id === "string" && operation.id.length > 0 ? [operation.id] : []);
    } catch (error) { releaseError = normalizeAwsError(error); }

    const observed = await this.observeIdleStaticIpWithIdentity(target, externalAccountId);
    const receipt = operationIds.length === 0 ? {} : { operationIds };
    if (observed.status === "released") return { status: "released", ...receipt };
    const rejectedNoEffect = releaseError !== undefined
      && ["permission_denied", "quota_exceeded", "rate_limited", "credentials_expired", "invalid_credentials"].includes(releaseError.code)
      && ((observed.status === "pending" && observed.reason === "release_pending")
        || (observed.status === "skipped" && observed.reason === "attached"));
    const retryAfterMs = releaseError === undefined ? observed.retryAfterMs : releaseError.retryAfterMs;
    return { status: "pending", reason: releaseError?.code ?? observed.reason ?? "release_pending", ...receipt,
      ...(rejectedNoEffect ? { rejectedNoEffect: true } : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }

  async observeIdleStaticIp(target: IdleStaticIp): Promise<IdleStaticIpReleaseResult> {
    try {
      const { externalAccountId } = await this.verifyIdentity();
      if (!validIdleStaticIpTarget(target, externalAccountId)) return { status: "skipped", reason: "remote_identity_changed" };
      return await this.observeIdleStaticIpWithIdentity(target, externalAccountId);
    } catch (error) {
      const normalized = normalizeAwsError(error);
      return { status: "pending", reason: normalized.code,
        ...(normalized.retryAfterMs === undefined ? {} : { retryAfterMs: normalized.retryAfterMs }),
      };
    }
  }

  private async observeIdleStaticIpWithIdentity(target: IdleStaticIp, externalAccountId: string): Promise<IdleStaticIpReleaseResult> {
    try {
      const { staticIp } = await this.lightsailSend(target.region, new GetStaticIpCommand({ staticIpName: target.name }));
      if (staticIp === undefined) return { status: "pending", reason: "remote_identity_changed" };
      const reason = idleStaticIpChange(target, staticIp, externalAccountId);
      return reason === undefined ? { status: "pending", reason: "release_pending" } : { status: "skipped", reason };
    } catch (error) {
      const normalized = normalizeAwsError(error);
      return normalized.code === "resource_not_found" ? { status: "released" } : { status: "pending", reason: normalized.code,
        ...(normalized.retryAfterMs === undefined ? {} : { retryAfterMs: normalized.retryAfterMs }),
      };
    }
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

  async inspectLifecycle(ref: CloudRef): Promise<CloudLifecycleSnapshot> {
    validateLightsailLifecycleRef(ref, this.accountId);
    let nativeName: string;
    try {
      nativeName = await this.findNameByArn(ref.region, ref.instanceId);
    } catch (error) {
      throw normalizeAwsError(error);
    }
    try {
      const { instance } = await this.lightsailSend(ref.region, new GetInstanceCommand({ instanceName: nativeName }));
      if (instance?.arn !== ref.instanceId || instance.name !== nativeName) throw new CloudError("remote_identity_changed", false);
      return { ref, identity: ref.instanceId, state: lightsailLifecycleState(instance.state?.name), nativeName };
    } catch (error) {
      const normalized = normalizeAwsError(error);
      if (normalized.code === "resource_not_found") return { ref, identity: ref.instanceId, state: "deleted", nativeName };
      throw normalized;
    }
  }

  async mutateLifecycle(action: CloudLifecycleAction, snapshot: CloudLifecycleSnapshot): Promise<CloudLifecycleReceipt> {
    assertLifecycleAction(action);
    assertLifecycleSnapshot(snapshot, this.accountId, "lightsail");
    validateLightsailLifecycleRef(snapshot.ref, this.accountId);
    if (snapshot.identity !== snapshot.ref.instanceId || typeof snapshot.nativeName !== "string" || !snapshot.nativeName) throw new CloudError("remote_identity_changed", false);
    let current: CloudLifecycleSnapshot;
    try {
      const { instance } = await this.lightsailSend(snapshot.ref.region, new GetInstanceCommand({ instanceName: snapshot.nativeName }));
      if (instance?.arn !== snapshot.identity || instance.name !== snapshot.nativeName) throw new CloudError("remote_identity_changed", false);
      current = { ref: snapshot.ref, identity: instance.arn, state: lightsailLifecycleState(instance.state?.name), nativeName: snapshot.nativeName };
    } catch (error) {
      const normalized = normalizeAwsError(error);
      if (normalized.code !== "resource_not_found") throw normalized;
      current = { ref: snapshot.ref, identity: snapshot.identity, state: "deleted", nativeName: snapshot.nativeName };
    }
    if (!sameLifecycleRef(current.ref, snapshot.ref) || current.identity !== snapshot.identity) throw new CloudError("remote_identity_changed", false);
    const noWrite = lifecycleNoWrite(action, current.state);
    if (noWrite !== undefined) return noWrite;
    try {
      const response = action === "start"
        ? await this.lightsailSend(snapshot.ref.region, new StartInstanceCommand({ instanceName: snapshot.nativeName }))
        : action === "stop"
          ? await this.lightsailSend(snapshot.ref.region, new StopInstanceCommand({ instanceName: snapshot.nativeName, force: false }))
          : await this.lightsailSend(snapshot.ref.region, new DeleteInstanceCommand({ instanceName: snapshot.nativeName, forceDeleteAddOns: false }));
      const ids = operationIds(response.operations);
      return ids.length === 0 ? {} : { operationIds: ids };
    } catch (error) {
      throw normalizeAwsError(error);
    }
  }

  async monthlyTraffic(ref: CloudRef, now = new Date()) {
    if (ref.accountId !== this.accountId || ref.service !== "lightsail") throw new CloudError("resource_not_found", false);
    try {
      const instanceName = await this.findNameByArn(ref.region, ref.instanceId);
      const { instance } = await this.lightsailSend(ref.region, new GetInstanceCommand({ instanceName }));
      if (instance?.arn !== ref.instanceId || instance.name !== instanceName) throw new CloudError("remote_identity_changed", false);
      const period = monthPeriod(now);
      const read = async (metricName: "NetworkIn" | "NetworkOut") => {
        const result = await this.lightsailSend(ref.region, new GetInstanceMetricDataCommand({ instanceName, metricName, startTime: period.start, endTime: period.end, period: 3600, statistics: ["Sum"], unit: "Bytes" }));
        return sumTraffic((result.metricData ?? []).map((point: { sum?: number }) => point.sum));
      };
      const [incoming, outgoing] = await Promise.all([read("NetworkIn"), read("NetworkOut")]);
      const gigabytes = trafficNumber(instance.networking?.monthlyTransfer?.gbPerMonth);
      return monthlyTrafficResult("lightsail", now, incoming, outgoing, gigabytes === null ? null : { gigabytes, scope: "region_bundle" });
    } catch (error) { throw normalizeAwsError(error); }
  }

  async inspectScoped(ref: CloudRef, scope: LightsailInspectionScope): Promise<CloudInventory> {
    if (ref.accountId !== this.accountId || ref.service !== "lightsail") throw new CloudError("resource_not_found", false);
    try {
      const instanceResponse = await this.lightsailSend(ref.region, new GetInstanceCommand({ instanceName: scope.instanceName }));
      const instance = instanceResponse.instance;
      if (!instance || instance.name !== scope.instanceName || instance.arn !== ref.instanceId) throw new CloudError("remote_identity_changed", false);
      let staticIps: StaticIp[] = [];
      let originalStatic: StaticIp | undefined;
      if (scope.ipv4.kind === "static") {
        const response = await this.lightsailSend(ref.region, new GetStaticIpCommand({ staticIpName: scope.ipv4.name }));
        originalStatic = response.staticIp as StaticIp | undefined;
        if (!originalStatic || !originalStatic.arn || !sameLightsailIdentity(instance.arn, originalStatic.arn, "StaticIp")
          || originalStatic.name !== scope.ipv4.name || originalStatic.ipAddress !== scope.ipv4.address
          || (scope.ipv4.resourceId !== undefined && originalStatic.arn !== scope.ipv4.resourceId)
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

      const originalActive = scope.ipv4.kind === "static" && originalStatic?.attachedTo === scope.instanceName
        && instance.isStaticIp === true && instance.publicIpAddress === scope.ipv4.address && candidateStatic?.attachedTo === undefined;
      const originalDynamic = scope.ipv4.kind === "dynamic" && instance.isStaticIp === false
        && instance.publicIpAddress === scope.ipv4.address && candidateStatic?.attachedTo === undefined;
      const detachedOriginal = scope.mode === "transition" && scope.allowDetachedOriginal === true && scope.ipv4.kind === "static"
        && originalStatic?.attachedTo === undefined && instance.isStaticIp === false && candidateStatic?.attachedTo === undefined;
      const candidateActive = scope.mode === "transition" && scope.allowCandidateAttached === true && candidateStatic?.attachedTo === scope.instanceName
        && instance.isStaticIp === true && instance.publicIpAddress === scope.candidate?.address
        && (scope.ipv4.kind === "dynamic" || originalStatic?.attachedTo === undefined);
      const ipv4Valid = originalActive || originalDynamic || detachedOriginal || candidateActive;
      const addresses = instance.ipv6Addresses ?? [];
      const originalIpv6 = scope.selected.family === 6 && scope.ipv6Candidate === undefined
        && instance.ipAddressType === "dualstack" && addresses.includes(scope.selected.address);
      const absentIpv6 = scope.selected.family === 6 && scope.mode === "transition" && scope.allowIpv6Absent === true
        && instance.ipAddressType === "ipv4" && addresses.length === 0;
      const newIpv6 = scope.selected.family === 6 && scope.mode === "transition" && scope.allowIpv6Candidate === true
        && instance.ipAddressType === "dualstack" && addresses.length === 1
        && (scope.ipv6Candidate === undefined || addresses[0] === scope.ipv6Candidate);
      const selectedValid = scope.selected.family === 4
        ? scope.selected.address === scope.ipv4.address
        : originalIpv6 || absentIpv6 || newIpv6;
      if (!ipv4Valid || !selectedValid) throw new CloudError("remote_identity_changed", false);

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

function validateLightsailLifecycleRef(ref: CloudRef, accountId: string): void {
  const match = /^arn:(?:aws|aws-[a-z0-9-]+):lightsail:([a-z]{2}(?:-[a-z0-9]+)+-[0-9]+):[0-9]{12}:Instance\/[A-Za-z0-9-]+$/.exec(ref.instanceId);
  if (ref.accountId !== accountId || ref.service !== "lightsail" || match?.[1] !== ref.region) throw new CloudError("remote_identity_changed", false);
}

function lightsailLifecycleState(value: unknown): CloudPowerState {
  if (value === "running") return "running";
  if (value === "stopped") return "stopped";
  if (value === "pending") return "starting";
  if (value === "stopping") return "stopping";
  return "unknown";
}

function sameLightsailIdentity(instanceArn: string, resourceArn: string, resourceType: string): boolean {
  const instance = instanceArn.split(":");
  const resource = resourceArn.split(":");
  return instance.length === 6 && resource.length === 6 && instance.slice(0, 5).every((part, index) => part === resource[index])
    && resource[5]?.startsWith(`${resourceType}/`) === true;
}

function staticIpIdentity(staticIp: StaticIp, region: string, externalAccountId: string): IdleStaticIp | undefined {
  const arn = staticIp.arn;
  if (typeof arn !== "string" || typeof staticIp.name !== "string" || !staticIp.name.trim()
    || typeof staticIp.ipAddress !== "string" || !isIPv4(staticIp.ipAddress)
    || !(staticIp.createdAt instanceof Date) || !Number.isFinite(staticIp.createdAt.getTime())) return undefined;
  const parts = /^arn:(aws(?:-[a-z0-9]+)*):lightsail:([a-z0-9-]+):(\d{12}):StaticIp\/([^:\s/]+)$/.exec(arn);
  if (!parts || parts[2] !== region || parts[3] !== externalAccountId
    || (staticIp.location?.regionName !== undefined && staticIp.location.regionName !== region)
    || (staticIp.resourceType !== undefined && staticIp.resourceType !== "StaticIp")) return undefined;
  return { region, name: staticIp.name, address: staticIp.ipAddress, arn, createdAt: staticIp.createdAt.toISOString() };
}

function sameIdleStaticIp(target: IdleStaticIp, current: IdleStaticIp | undefined): boolean {
  return current !== undefined && current.region === target.region && current.name === target.name
    && current.address === target.address && current.arn === target.arn && current.createdAt === target.createdAt;
}

function validIdleStaticIpTarget(target: IdleStaticIp, externalAccountId: string): boolean {
  return sameIdleStaticIp(target, staticIpIdentity({
    name: target.name, ipAddress: target.address, arn: target.arn, createdAt: new Date(target.createdAt),
  }, target.region, externalAccountId));
}

function idleStaticIpChange(target: IdleStaticIp, current: StaticIp | undefined, externalAccountId: string): string | undefined {
  if (current === undefined || !sameIdleStaticIp(target, staticIpIdentity(current, target.region, externalAccountId))) return "remote_identity_changed";
  if (current.isAttached !== false || current.attachedTo !== undefined) return "attached";
  return undefined;
}
