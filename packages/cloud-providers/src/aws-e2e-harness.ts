import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { CloudStep, SlotRef } from "@masterdns/contracts";

import type { AwsCredentials, CloudAdapter, CloudInventory, CloudObservation, CloudStepResult } from "./provider.js";
import type { LightsailInspectionScope } from "./lightsail.js";
import { rotationResourceName } from "./resource-ownership.js";
import { planCloudRotation, rotationArguments } from "./rotation-plan.js";

const requiredEnvironment = [
  "MASTERDNS_AWS_E2E_ACCESS_KEY_ID",
  "MASTERDNS_AWS_E2E_SECRET_ACCESS_KEY",
  "MASTERDNS_AWS_E2E_SESSION_TOKEN",
  "MASTERDNS_AWS_E2E_ACCOUNT_ID",
  "MASTERDNS_AWS_E2E_SERVICE",
  "MASTERDNS_AWS_E2E_REGION",
  "MASTERDNS_AWS_E2E_INSTANCE_ID",
  "MASTERDNS_AWS_E2E_SLOT_ID",
  "MASTERDNS_AWS_E2E_INTERFACE_ID",
  "MASTERDNS_AWS_E2E_ADDRESS",
  "MASTERDNS_AWS_E2E_FAMILY",
] as const;

const allowedActions = new Set([
  "ec2.auto-ipv4.disable",
  "ec2.auto-ipv4.enable",
  "ec2.eip.allocate",
  "ec2.eip.associate",
  "ec2.ipv6.assign",
  "lightsail.static-ip.allocate",
  "lightsail.static-ip.detach",
  "lightsail.static-ip.attach",
  "lightsail.ipv6.disable",
  "lightsail.ipv6.enable",
]);

export type AwsE2eConfig = {
  credentials: AwsCredentials;
  scope: SlotRef;
  lightsailScope?: { instanceName: string; ipv4Address: string; staticIpName?: string };
  write: boolean;
  journalPath?: string;
  observeTimeoutMs: number;
  observeIntervalMs: number;
};

export type AwsE2eLoadResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: "ready"; config: AwsE2eConfig };

export type AwsE2eJournalStep = {
  step: CloudStep;
  state: "planned" | "dispatched" | "received" | "pending" | "applied" | "needs_review";
  receipt?: CloudStepResult;
  observation?: CloudObservation;
};

export type AwsE2eJournal = {
  version: 1;
  attemptId: string;
  scope: SlotRef;
  lightsailScope?: { instanceName: string; ipv4Address: string; staticIpName?: string };
  original: CloudInventory;
  phase: "running" | "pending" | "needs_review" | "completed";
  steps: AwsE2eJournalStep[];
};

export interface AwsE2eJournalLease {
  load(): Promise<AwsE2eJournal | undefined>;
  save(journal: AwsE2eJournal): Promise<void>;
  release(): Promise<void>;
}

export interface AwsE2eJournalStore {
  acquire(): Promise<AwsE2eJournalLease>;
}

export type AwsE2eResult =
  | { outcome: "read_only"; scope: SlotRef; state: string; plannedActions: string[] }
  | { outcome: "completed"; scope: SlotRef; state: string; attemptId: string; candidateAddress?: string; allocationId?: string; resourceId?: string }
  | { outcome: "pending" | "needs_review"; scope: SlotRef; state: string; attemptId: string; action: string; candidateAddress?: string; allocationId?: string; resourceId?: string };

type RunDependencies = {
  adapter: CloudAdapter;
  journal?: AwsE2eJournalStore;
  inspect?: (ref: SlotRef, scope?: LightsailInspectionScope) => Promise<CloudInventory>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class FileAwsE2eJournalStore implements AwsE2eJournalStore {
  constructor(private readonly path: string) {}

  async acquire(): Promise<AwsE2eJournalLease> {
    const directory = dirname(this.path);
    const lockPath = `${this.path}.lock`;
    const owner = { version: 1, pid: process.pid, host: hostname(), id: randomUUID() };
    await mkdir(directory, { recursive: true });
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(await lockFailureCode(lockPath));
      }
      throw error;
    }

    return {
      load: async () => {
        try {
          return JSON.parse(await readFile(this.path, "utf8")) as AwsE2eJournal;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      },
      save: async (journal) => {
        const value = validateJournal(journal);
        const temporaryPath = `${this.path}.tmp-${process.pid}-${owner.id}`;
        const handle = await open(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, "utf8");
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(temporaryPath).catch(() => undefined);
          throw error;
        }
        await handle.close();
        await rename(temporaryPath, this.path);
        await syncDirectory(directory);
      },
      release: async () => {
        const current = JSON.parse(await readFile(lockPath, "utf8")) as { id?: unknown };
        if (current.id !== owner.id) throw new Error("journal_lock_lost");
        await unlink(lockPath);
        await syncDirectory(directory);
      },
    };
  }
}

export function loadAwsE2eConfig(environment: NodeJS.ProcessEnv | Record<string, string | undefined>): AwsE2eLoadResult {
  const missing = requiredEnvironment.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) return { outcome: "skipped", reason: `missing required environment: ${missing.join(", ")}` };

  const service = environment.MASTERDNS_AWS_E2E_SERVICE;
  const family = Number(environment.MASTERDNS_AWS_E2E_FAMILY);
  const address = environment.MASTERDNS_AWS_E2E_ADDRESS!;
  if (service !== "ec2" && service !== "lightsail") throw new Error("invalid MASTERDNS_AWS_E2E_SERVICE");
  if ((family !== 4 && family !== 6) || isIP(address) !== family) throw new Error("invalid MASTERDNS_AWS_E2E_ADDRESS or MASTERDNS_AWS_E2E_FAMILY");
  if (!/^\d{12}$/.test(environment.MASTERDNS_AWS_E2E_ACCOUNT_ID!)) throw new Error("invalid MASTERDNS_AWS_E2E_ACCOUNT_ID");
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(environment.MASTERDNS_AWS_E2E_REGION!)) throw new Error("invalid MASTERDNS_AWS_E2E_REGION");
  if (service === "ec2" && (!/^i-[A-Za-z0-9]+$/.test(environment.MASTERDNS_AWS_E2E_INSTANCE_ID!) || !/^eni-[A-Za-z0-9]+$/.test(environment.MASTERDNS_AWS_E2E_INTERFACE_ID!))) {
    throw new Error("invalid EC2 instance or interface scope");
  }
  if (service === "lightsail" && (!environment.MASTERDNS_AWS_E2E_INSTANCE_ID!.startsWith("arn:aws") || environment.MASTERDNS_AWS_E2E_INTERFACE_ID !== "primary")) {
    throw new Error("invalid Lightsail instance or interface scope");
  }
  const lightsailMissing = service === "lightsail"
    ? ["MASTERDNS_AWS_E2E_LIGHTSAIL_INSTANCE_NAME", "MASTERDNS_AWS_E2E_LIGHTSAIL_STATIC_IP_NAME",
      ...(family === 6 ? ["MASTERDNS_AWS_E2E_LIGHTSAIL_IPV4_ADDRESS"] : [])].filter((name) => !environment[name]?.trim())
    : [];
  if (lightsailMissing.length > 0) return { outcome: "skipped", reason: `missing required environment: ${lightsailMissing.join(", ")}` };
  const lightsailInstanceName = environment.MASTERDNS_AWS_E2E_LIGHTSAIL_INSTANCE_NAME?.trim();
  const lightsailStaticIpValue = environment.MASTERDNS_AWS_E2E_LIGHTSAIL_STATIC_IP_NAME?.trim();
  const lightsailIpv4Address = family === 4 ? address : environment.MASTERDNS_AWS_E2E_LIGHTSAIL_IPV4_ADDRESS?.trim();
  if (service === "lightsail" && (!isLightsailName(lightsailInstanceName!) || (lightsailStaticIpValue !== "none" && !isLightsailName(lightsailStaticIpValue!)))) {
    throw new Error("invalid Lightsail native resource scope");
  }
  if (service === "lightsail" && isIP(lightsailIpv4Address!) !== 4) throw new Error("invalid MASTERDNS_AWS_E2E_LIGHTSAIL_IPV4_ADDRESS");

  const write = environment.MASTERDNS_AWS_E2E_WRITE === "1";
  if (environment.MASTERDNS_AWS_E2E_WRITE && !write) throw new Error("MASTERDNS_AWS_E2E_WRITE must be 1 when set");
  const journalPath = environment.MASTERDNS_AWS_E2E_JOURNAL?.trim();
  if (write && !journalPath) return { outcome: "skipped", reason: "write mode requires MASTERDNS_AWS_E2E_JOURNAL" };

  return {
    outcome: "ready",
    config: {
      credentials: {
        kind: "access_key",
        accessKeyId: environment.MASTERDNS_AWS_E2E_ACCESS_KEY_ID!,
        secretAccessKey: environment.MASTERDNS_AWS_E2E_SECRET_ACCESS_KEY!,
        sessionToken: environment.MASTERDNS_AWS_E2E_SESSION_TOKEN!,
      },
      scope: {
        accountId: environment.MASTERDNS_AWS_E2E_ACCOUNT_ID!,
        service,
        region: environment.MASTERDNS_AWS_E2E_REGION!,
        instanceId: environment.MASTERDNS_AWS_E2E_INSTANCE_ID!,
        slotId: environment.MASTERDNS_AWS_E2E_SLOT_ID!,
        interfaceId: environment.MASTERDNS_AWS_E2E_INTERFACE_ID!,
        address,
        family,
      },
      ...(service === "lightsail" ? { lightsailScope: {
        instanceName: lightsailInstanceName!,
        ipv4Address: lightsailIpv4Address!,
        ...(lightsailStaticIpValue === "none" ? {} : { staticIpName: lightsailStaticIpValue! }),
      } } : {}),
      write,
      ...(journalPath ? { journalPath } : {}),
      observeTimeoutMs: parseDuration(environment.MASTERDNS_AWS_E2E_OBSERVE_TIMEOUT_MS, 30_000, "MASTERDNS_AWS_E2E_OBSERVE_TIMEOUT_MS"),
      observeIntervalMs: parseDuration(environment.MASTERDNS_AWS_E2E_OBSERVE_INTERVAL_MS, 2_000, "MASTERDNS_AWS_E2E_OBSERVE_INTERVAL_MS"),
    },
  };
}

export async function runAwsE2e(config: AwsE2eConfig, dependencies: RunDependencies): Promise<AwsE2eResult> {
  if (config.write && !config.journalPath) throw new Error("cloud_writes_not_enabled");
  const store = dependencies.journal ?? (config.journalPath ? new FileAwsE2eJournalStore(config.journalPath) : undefined);
  if (config.write && !store) throw new Error("cloud_writes_not_enabled");

  if (!config.write) return await runAwsE2eWithLease(config, dependencies);
  const lease = await store!.acquire();
  try {
    return await runAwsE2eWithLease(config, dependencies, lease);
  } finally {
    await lease.release();
  }
}

async function runAwsE2eWithLease(config: AwsE2eConfig, dependencies: RunDependencies, lease?: AwsE2eJournalLease): Promise<AwsE2eResult> {
  let journal = config.write ? await lease!.load() : undefined;
  if (journal !== undefined) {
    journal = validateJournal(journal);
    assertSameScope(journal.scope, config.scope, "journal_scope_mismatch");
    if (!isDeepStrictEqual(journal.lightsailScope, config.lightsailScope)) throw new Error("journal_scope_mismatch");
  }

  await assertIdentity(dependencies.adapter, config.scope.accountId);
  const current = await inspect(config, dependencies, journal);
  assertInventoryScope(config.scope, current, journal === undefined);

  if (journal === undefined) {
    const plan = planCloudRotation(config.scope, current, { allowStop: false, attemptId: createAttemptId() });
    validatePlan(plan, config.scope);
    if (!config.write) return { outcome: "read_only", scope: config.scope, state: current.state, plannedActions: plan.map((step) => step.action) };
    const attemptId = rotationArguments(plan[0]!).attemptId;
    journal = {
      version: 1,
      attemptId,
      scope: structuredClone(config.scope),
      ...(config.lightsailScope ? { lightsailScope: structuredClone(config.lightsailScope) } : {}),
      original: structuredClone(current),
      phase: "running",
      steps: plan.map((step) => ({ step, state: "planned" })),
    };
    await lease!.save(journal);
  }

  const firstIncomplete = journal.steps.findIndex((entry) => entry.state !== "applied");
  if ((firstIncomplete < 0 || journal.steps[firstIncomplete]?.state === "planned") && firstIncomplete !== 0) {
    const lastApplied = journal.steps[firstIncomplete < 0 ? journal.steps.length - 1 : firstIncomplete - 1]!;
    const observation = await observeUntilSettled(config, dependencies, lastApplied.step);
    if (observation.status !== "applied") throw new Error("journal_applied_state_unverified");
  }
  if (journal.phase === "completed") {
    return resultFromJournal("completed", journal, current.state);
  }
  for (let index = 0; index < journal.steps.length; index++) {
    const entry = journal.steps[index]!;
    if (entry.state === "applied") continue;
    assertStepScope(entry.step, config.scope, journal.attemptId);

    if (entry.state === "planned") {
      await assertIdentity(dependencies.adapter, config.scope.accountId);
      const beforeMutation = await inspect(config, dependencies, journal);
      assertInventoryScope(config.scope, beforeMutation, false);
      entry.state = "dispatched";
      journal.phase = "running";
      await lease!.save(journal);
      const receipt = await dependencies.adapter.execute(entry.step);
      entry.receipt = receipt;
      entry.step.arguments.receipt = structuredClone(receipt);
      entry.state = "received";
      await lease!.save(journal);
    }

    const observation = await observeUntilSettled(config, dependencies, entry.step);
    entry.observation = observation;
    if (observation.status === "applied") {
      entry.receipt = mergeEvidence(entry.receipt, observation);
      entry.step.arguments.receipt = structuredClone(entry.receipt);
      carryCandidateReceipt(journal, index, entry.receipt);
      entry.state = "applied";
      journal.phase = "running";
      await lease!.save(journal);
      continue;
    }

    entry.state = observation.status === "pending" ? "pending" : "needs_review";
    journal.phase = observation.status === "pending" ? "pending" : "needs_review";
    await lease!.save(journal);
    return resultFromJournal(journal.phase, journal, current.state, entry);
  }

  journal.phase = "completed";
  await lease!.save(journal);
  const finalInventory = await inspect(config, dependencies, journal);
  assertInventoryScope(config.scope, finalInventory, false);
  return resultFromJournal("completed", journal, finalInventory.state);
}

async function observeUntilSettled(config: AwsE2eConfig, dependencies: RunDependencies, step: CloudStep): Promise<CloudObservation> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + config.observeTimeoutMs;
  let observation: CloudObservation;
  do {
    observation = dependencies.adapter.observeDetails
      ? await dependencies.adapter.observeDetails(step)
      : { status: await dependencies.adapter.observe(step) };
    if (observation.status !== "pending" || now() >= deadline) return observation;
    await sleep(Math.min(config.observeIntervalMs, Math.max(0, deadline - now())));
  } while (true);
}

function carryCandidateReceipt(journal: AwsE2eJournal, index: number, receipt: CloudStepResult): void {
  if (!journal.steps[index]?.step.action.endsWith("allocate")) return;
  for (const later of journal.steps.slice(index + 1)) later.step.arguments.candidateReceipt = structuredClone(receipt);
}

function mergeEvidence(receipt: CloudStepResult | undefined, observation: CloudObservation): CloudStepResult {
  const { status: _, ...details } = observation;
  return { ...receipt, ...details };
}

function resultFromJournal(outcome: "completed" | "pending" | "needs_review", journal: AwsE2eJournal, state: string, entry?: AwsE2eJournalStep): AwsE2eResult {
  const evidence = entry?.observation ?? entry?.receipt ?? [...journal.steps].reverse().find((candidate) => candidate.observation || candidate.receipt)?.observation
    ?? [...journal.steps].reverse().find((candidate) => candidate.receipt)?.receipt;
  const identity = evidence ? {
    ...(evidence.candidateAddress ? { candidateAddress: evidence.candidateAddress } : {}),
    ...(evidence.allocationId ? { allocationId: evidence.allocationId } : {}),
    ...(evidence.resourceId ? { resourceId: evidence.resourceId } : {}),
  } : {};
  if (outcome === "completed") return { outcome, scope: journal.scope, state, attemptId: journal.attemptId, ...identity };
  return { outcome, scope: journal.scope, state, attemptId: journal.attemptId, action: entry!.step.action, ...identity };
}

function validateJournal(value: unknown): AwsE2eJournal {
  if (!isRecord(value) || value.version !== 1 || typeof value.attemptId !== "string" || !isSlotRef(value.scope)
    || !isCloudInventory(value.original)
    || !["running", "pending", "needs_review", "completed"].includes(String(value.phase)) || !Array.isArray(value.steps)
    || value.steps.length < 1 || value.steps.length > 3
    || !hasOnlyKeys(value, ["version", "attemptId", "scope", "lightsailScope", "original", "phase", "steps"])) throw new Error("invalid_aws_e2e_journal");
  const journal = value as unknown as AwsE2eJournal;
  if ((journal.scope.service === "lightsail" && !isLightsailScope(journal.lightsailScope))
    || (journal.scope.service === "ec2" && journal.lightsailScope !== undefined)) throw new Error("invalid_aws_e2e_journal");
  assertInventoryScope(journal.scope, journal.original, true);
  if (journal.scope.service === "lightsail") {
    const originalAddress = journal.original.interfaces.find((networkInterface) => networkInterface.id === journal.scope.interfaceId)
      ?.addresses.find((address) => address.address === journal.lightsailScope!.ipv4Address && address.family === 4);
    const staticName = journal.lightsailScope!.staticIpName;
    if (!originalAddress || (staticName !== undefined
      ? originalAddress.allocationId !== staticName || !originalAddress.resourceId
      : originalAddress.allocationId !== undefined || originalAddress.resourceId !== undefined)) throw new Error("invalid_aws_e2e_journal");
  }
  const steps = journal.steps.map((entry) => {
    if (!isRecord(entry) || !["planned", "dispatched", "received", "pending", "applied", "needs_review"].includes(String(entry.state)) || !isRecord(entry.step)) {
      throw new Error("invalid_aws_e2e_journal");
    }
    if (!hasOnlyKeys(entry, ["step", "state", "receipt", "observation"])
      || (entry.receipt !== undefined && !isStepResult(entry.receipt, false))
      || (entry.observation !== undefined && !isStepResult(entry.observation, true))) throw new Error("invalid_aws_e2e_journal");
    return entry.step as unknown as CloudStep;
  });
  validatePlan(steps, journal.scope, journal.attemptId, journal.original);
  const firstIncomplete = journal.steps.findIndex((entry) => entry.state !== "applied");
  if (firstIncomplete >= 0 && journal.steps.slice(firstIncomplete + 1).some((entry) => entry.state !== "planned")) {
    throw new Error("invalid_aws_e2e_journal");
  }
  const activeState = firstIncomplete < 0 ? undefined : journal.steps[firstIncomplete]!.state;
  if ((journal.phase === "completed" && firstIncomplete >= 0)
    || (journal.phase === "pending" && activeState !== "pending")
    || (journal.phase === "needs_review" && activeState !== "needs_review")
    || (journal.phase === "running" && (activeState === "pending" || activeState === "needs_review"))) {
    throw new Error("invalid_aws_e2e_journal");
  }
  let candidateReceipt: CloudStepResult | undefined;
  for (const entry of journal.steps) {
    const args = rotationArguments(entry.step);
    const receiptMatches = isDeepStrictEqual(args.receipt, entry.receipt);
    const candidateMatches = isDeepStrictEqual(args.candidateReceipt, candidateReceipt);
    if (!receiptMatches || !candidateMatches) throw new Error("invalid_aws_e2e_journal");
    if ((entry.state === "planned" || entry.state === "dispatched") && (entry.receipt !== undefined || entry.observation !== undefined)) throw new Error("invalid_aws_e2e_journal");
    if (entry.state === "received" && (entry.receipt === undefined || entry.observation !== undefined)) throw new Error("invalid_aws_e2e_journal");
    if (entry.state === "pending" && entry.observation?.status !== "pending") throw new Error("invalid_aws_e2e_journal");
    if (entry.state === "needs_review" && entry.observation?.status !== "ambiguous" && entry.observation?.status !== "not_applied") throw new Error("invalid_aws_e2e_journal");
    if (entry.state === "applied" && (entry.receipt === undefined || entry.observation?.status !== "applied")) throw new Error("invalid_aws_e2e_journal");
    if (entry.state === "applied" && entry.step.action.endsWith("allocate")) candidateReceipt = entry.receipt;
  }
  return journal;
}

function validatePlan(plan: CloudStep[], scope: SlotRef, attemptId?: string, original?: CloudInventory): void {
  if (plan.length < 1 || plan.length > 3) throw new Error("invalid_aws_e2e_plan");
  let canonical: CloudStep[] | undefined;
  try {
    canonical = original && attemptId ? planCloudRotation(scope, original, { allowStop: false, attemptId }) : undefined;
  } catch {
    throw new Error("invalid_aws_e2e_plan");
  }
  if (canonical && canonical.length !== plan.length) throw new Error("invalid_aws_e2e_plan");
  const ids = new Set<string>();
  for (const [index, step] of plan.entries()) {
    const args = rotationArguments(step);
    if (!allowedActions.has(step.action) || args.phase !== "rotation" || ids.has(step.id)) throw new Error("invalid_aws_e2e_plan");
    ids.add(step.id);
    assertSameScope(args.slot, scope, "invalid_aws_e2e_plan");
    if (attemptId !== undefined && args.attemptId !== attemptId) throw new Error("invalid_aws_e2e_plan");
    if (canonical) {
      if (!hasOnlyKeys(step, ["id", "action", "resourceKey", "arguments", "destructive"])) throw new Error("invalid_aws_e2e_plan");
      const { receipt: _receipt, candidateReceipt: _candidateReceipt, ...immutableArguments } = step.arguments;
      if (!isDeepStrictEqual({ ...step, arguments: immutableArguments }, canonical[index])) throw new Error("invalid_aws_e2e_plan");
    }
  }
}

function assertStepScope(step: CloudStep, scope: SlotRef, attemptId: string): void {
  const args = rotationArguments(step);
  if (!allowedActions.has(step.action) || args.phase !== "rotation" || args.attemptId !== attemptId) throw new Error("step_scope_mismatch");
  assertSameScope(args.slot, scope, "step_scope_mismatch");
}

function assertInventoryScope(scope: SlotRef, inventory: CloudInventory, requireAddress: boolean): void {
  assertSameScope(inventory.ref, scope, "scope_instance_mismatch", ["accountId", "service", "region", "instanceId"]);
  const networkInterface = inventory.interfaces.find((candidate) => candidate.id === scope.interfaceId);
  if (!networkInterface) throw new Error("scope_interface_mismatch");
  if (requireAddress && !networkInterface.addresses.some((candidate) => candidate.address === scope.address && candidate.family === scope.family)) {
    throw new Error("scope_address_mismatch");
  }
}

async function assertIdentity(adapter: CloudAdapter, expectedAccountId: string): Promise<void> {
  const identity = await adapter.verifyIdentity();
  if (identity.externalAccountId !== expectedAccountId) throw new Error("scope_account_mismatch");
}

function assertSameScope(actual: Pick<SlotRef, "accountId" | "service" | "region" | "instanceId"> & Partial<SlotRef>, expected: SlotRef, code: string, fields: Array<keyof SlotRef> = ["accountId", "service", "region", "instanceId", "slotId", "interfaceId", "address", "family"]): void {
  if (fields.some((field) => actual[field] !== expected[field])) throw new Error(code);
}

function isSlotRef(value: unknown): value is SlotRef {
  if (!isRecord(value)) return false;
  return typeof value.accountId === "string" && (value.service === "ec2" || value.service === "lightsail")
    && typeof value.region === "string" && typeof value.instanceId === "string" && typeof value.slotId === "string"
    && typeof value.interfaceId === "string" && typeof value.address === "string" && (value.family === 4 || value.family === 6);
}

function isCloudInventory(value: unknown): value is CloudInventory {
  if (!isRecord(value) || !isRecord(value.ref) || !Array.isArray(value.interfaces)
    || typeof value.name !== "string" || typeof value.state !== "string") return false;
  return value.interfaces.every((networkInterface) => isRecord(networkInterface) && typeof networkInterface.id === "string"
    && Array.isArray(networkInterface.addresses) && networkInterface.addresses.every((address) => isRecord(address)
      && typeof address.address === "string" && (address.family === 4 || address.family === 6) && typeof address.primary === "boolean"));
}

function isLightsailScope(value: unknown): value is NonNullable<AwsE2eConfig["lightsailScope"]> {
  return isRecord(value) && typeof value.instanceName === "string" && isLightsailName(value.instanceName)
    && typeof value.ipv4Address === "string" && isIP(value.ipv4Address) === 4
    && (value.staticIpName === undefined || (typeof value.staticIpName === "string" && isLightsailName(value.staticIpName)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isStepResult(value: unknown, observation: boolean): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "remoteId", "resourceId", "allocationId", "operationId", "operationIds", "candidateAddress", "candidateRepeated", "before", "after", ...(observation ? ["status"] : []),
  ])) return false;
  if ([value.remoteId, value.resourceId, value.allocationId, value.operationId, value.candidateAddress]
    .some((field) => field !== undefined && typeof field !== "string")) return false;
  if (value.operationIds !== undefined && (!Array.isArray(value.operationIds) || value.operationIds.some((id) => typeof id !== "string"))) return false;
  if (value.candidateRepeated !== undefined && typeof value.candidateRepeated !== "boolean") return false;
  if ((value.before !== undefined && !isRecord(value.before)) || (value.after !== undefined && !isRecord(value.after))) return false;
  return !observation || ["pending", "applied", "not_applied", "ambiguous"].includes(String(value.status));
}

function parseDuration(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 300_000) throw new Error(`invalid ${name}`);
  return parsed;
}

function isLightsailName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(value);
}

function inspect(config: AwsE2eConfig, dependencies: RunDependencies, journal?: AwsE2eJournal): Promise<CloudInventory> {
  if (config.scope.service !== "lightsail") return dependencies.inspect?.(config.scope) ?? dependencies.adapter.inspect(config.scope);
  const scope = lightsailInspectionScope(config, journal);
  if (dependencies.inspect) return dependencies.inspect(config.scope, scope);
  const adapter = dependencies.adapter as CloudAdapter & {
    inspectScoped?: (ref: SlotRef, scope: LightsailInspectionScope) => Promise<CloudInventory>;
  };
  if (!adapter.inspectScoped) throw new Error("lightsail_scoped_inspection_required");
  return adapter.inspectScoped(config.scope, scope);
}

function lightsailInspectionScope(config: AwsE2eConfig, journal?: AwsE2eJournal): LightsailInspectionScope {
  if (!config.lightsailScope) throw new Error("lightsail_scoped_inspection_required");
  if (journal === undefined) return {
    mode: "initial",
    instanceName: config.lightsailScope.instanceName,
    selected: { family: config.scope.family, address: config.scope.address },
    ipv4: config.lightsailScope.staticIpName
      ? { kind: "static", name: config.lightsailScope.staticIpName, address: config.lightsailScope.ipv4Address }
      : { kind: "dynamic", address: config.lightsailScope.ipv4Address },
  };
  const networkInterface = journal.original.interfaces.find((candidate) => candidate.id === config.scope.interfaceId);
  const selectedAddress = networkInterface?.addresses.find((address) => address.address === config.scope.address && address.family === config.scope.family);
  const originalIpv4 = networkInterface?.addresses.find((address) => address.address === config.lightsailScope!.ipv4Address && address.family === 4);
  if (!selectedAddress || !originalIpv4) throw new Error("invalid_aws_e2e_journal");
  const allocation = journal.steps.find((entry) => entry.step.action === "lightsail.static-ip.allocate" && entry.state === "applied");
  const candidate = allocation?.receipt;
  if (allocation && (!candidate?.allocationId || candidate.allocationId !== rotationResourceName(allocation.step)
    || !candidate.resourceId || !candidate.candidateAddress)) throw new Error("invalid_aws_e2e_journal");
  const detach = journal.steps.find((entry) => entry.step.action === "lightsail.static-ip.detach");
  const attach = journal.steps.find((entry) => entry.step.action === "lightsail.static-ip.attach");
  const disable = journal.steps.find((entry) => entry.step.action === "lightsail.ipv6.disable");
  const enable = journal.steps.find((entry) => entry.step.action === "lightsail.ipv6.enable");
  const ipv6Candidate = enable?.state === "applied" ? enable.receipt?.candidateAddress : undefined;
  if (enable?.state === "applied" && (!ipv6Candidate || isIP(ipv6Candidate) !== 6)) throw new Error("invalid_aws_e2e_journal");
  return {
    mode: "transition",
    instanceName: config.lightsailScope.instanceName,
    selected: { family: config.scope.family, address: selectedAddress.address },
    ipv4: originalIpv4.allocationId && originalIpv4.resourceId
      ? { kind: "static", name: originalIpv4.allocationId, address: originalIpv4.address, resourceId: originalIpv4.resourceId }
      : { kind: "dynamic", address: originalIpv4.address },
    ...(candidate ? { candidate: { name: candidate.allocationId!, address: candidate.candidateAddress!, resourceId: candidate.resourceId! } } : {}),
    ...(detach && detach.state !== "planned" ? { allowDetachedOriginal: true } : {}),
    ...(attach && attach.state !== "planned" ? { allowCandidateAttached: true } : {}),
    ...(disable && disable.state !== "planned" && enable?.state !== "applied" ? { allowIpv6Absent: true } : {}),
    ...(enable && enable.state !== "planned" ? { allowIpv6Candidate: true } : {}),
    ...(ipv6Candidate ? { ipv6Candidate } : {}),
  };
}

function createAttemptId(): string {
  return `aws-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function lockFailureCode(lockPath: string): Promise<"journal_locked" | "journal_lock_stale"> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown; host?: unknown };
    if (value.host !== hostname() || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return "journal_locked";
    try {
      process.kill(value.pid, 0);
      return "journal_locked";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "journal_lock_stale" : "journal_locked";
    }
  } catch {
    return "journal_locked";
  }
}
