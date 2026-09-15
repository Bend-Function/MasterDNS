import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";

import type { CloudStep, SlotRef } from "@masterdns/contracts";

import type { AwsCredentials, CloudAdapter, CloudInventory, CloudObservation, CloudStepResult } from "./provider.js";
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
  phase: "running" | "pending" | "needs_review" | "completed";
  steps: AwsE2eJournalStep[];
};

export interface AwsE2eJournalStore {
  load(): Promise<AwsE2eJournal | undefined>;
  save(journal: AwsE2eJournal): Promise<void>;
}

export type AwsE2eResult =
  | { outcome: "read_only"; scope: SlotRef; state: string; plannedActions: string[] }
  | { outcome: "completed"; scope: SlotRef; state: string; attemptId: string; candidateAddress?: string; allocationId?: string; resourceId?: string }
  | { outcome: "pending" | "needs_review"; scope: SlotRef; state: string; attemptId: string; action: string; candidateAddress?: string; allocationId?: string; resourceId?: string };

type RunDependencies = {
  adapter: CloudAdapter;
  journal?: AwsE2eJournalStore;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class FileAwsE2eJournalStore implements AwsE2eJournalStore {
  constructor(private readonly path: string) {}

  async load(): Promise<AwsE2eJournal | undefined> {
    try {
      return validateJournal(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(journal: AwsE2eJournal): Promise<void> {
    const value = validateJournal(journal);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporaryPath, `${JSON.stringify(value, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
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

  let journal = config.write ? await store!.load() : undefined;
  if (journal) {
    journal = validateJournal(journal);
    assertSameScope(journal.scope, config.scope, "journal_scope_mismatch");
  }

  await assertIdentity(dependencies.adapter, config.scope.accountId);
  const current = await dependencies.adapter.inspect(config.scope);
  assertInventoryScope(config.scope, current, journal === undefined);

  if (!journal) {
    const plan = planCloudRotation(config.scope, current, { allowStop: false, attemptId: createAttemptId() });
    validatePlan(plan, config.scope);
    if (!config.write) return { outcome: "read_only", scope: config.scope, state: current.state, plannedActions: plan.map((step) => step.action) };
    const attemptId = rotationArguments(plan[0]!).attemptId;
    journal = {
      version: 1,
      attemptId,
      scope: structuredClone(config.scope),
      phase: "running",
      steps: plan.map((step) => ({ step, state: "planned" })),
    };
    await store!.save(journal);
  }

  if (journal.phase === "completed") return resultFromJournal("completed", journal, current.state);
  for (let index = 0; index < journal.steps.length; index++) {
    const entry = journal.steps[index]!;
    if (entry.state === "applied") continue;
    assertStepScope(entry.step, config.scope, journal.attemptId);

    if (entry.state === "planned") {
      await assertIdentity(dependencies.adapter, config.scope.accountId);
      const beforeMutation = await dependencies.adapter.inspect(config.scope);
      assertInventoryScope(config.scope, beforeMutation, false);
      entry.state = "dispatched";
      journal.phase = "running";
      await store!.save(journal);
      const receipt = await dependencies.adapter.execute(entry.step);
      entry.receipt = receipt;
      entry.step.arguments.receipt = structuredClone(receipt);
      carryCandidateReceipt(journal, index, receipt);
      entry.state = "received";
      await store!.save(journal);
    }

    const observation = await observeUntilSettled(config, dependencies, entry.step);
    entry.observation = observation;
    if (observation.status === "applied") {
      entry.receipt = mergeEvidence(entry.receipt, observation);
      entry.step.arguments.receipt = structuredClone(entry.receipt);
      carryCandidateReceipt(journal, index, entry.receipt);
      entry.state = "applied";
      journal.phase = "running";
      await store!.save(journal);
      continue;
    }

    entry.state = observation.status === "pending" ? "pending" : "needs_review";
    journal.phase = observation.status === "pending" ? "pending" : "needs_review";
    await store!.save(journal);
    return resultFromJournal(journal.phase, journal, current.state, entry);
  }

  journal.phase = "completed";
  await store!.save(journal);
  const finalInventory = await dependencies.adapter.inspect(config.scope);
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
    || !["running", "pending", "needs_review", "completed"].includes(String(value.phase)) || !Array.isArray(value.steps)
    || value.steps.length < 1 || value.steps.length > 3) throw new Error("invalid_aws_e2e_journal");
  const journal = value as unknown as AwsE2eJournal;
  validatePlan(journal.steps.map((entry) => {
    if (!isRecord(entry) || !["planned", "dispatched", "received", "pending", "applied", "needs_review"].includes(String(entry.state)) || !isRecord(entry.step)) {
      throw new Error("invalid_aws_e2e_journal");
    }
    return entry.step as unknown as CloudStep;
  }), journal.scope, journal.attemptId);
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
  return journal;
}

function validatePlan(plan: CloudStep[], scope: SlotRef, attemptId?: string): void {
  if (plan.length < 1 || plan.length > 3) throw new Error("invalid_aws_e2e_plan");
  const ids = new Set<string>();
  for (const step of plan) {
    const args = rotationArguments(step);
    if (!allowedActions.has(step.action) || args.phase !== "rotation" || ids.has(step.id)) throw new Error("invalid_aws_e2e_plan");
    ids.add(step.id);
    assertSameScope(args.slot, scope, "invalid_aws_e2e_plan");
    if (attemptId !== undefined && args.attemptId !== attemptId) throw new Error("invalid_aws_e2e_plan");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDuration(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 300_000) throw new Error(`invalid ${name}`);
  return parsed;
}

function createAttemptId(): string {
  return `aws-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
}
