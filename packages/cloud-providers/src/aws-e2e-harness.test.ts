import type { SlotRef } from "@masterdns/contracts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FileAwsE2eJournalStore,
  loadAwsE2eConfig,
  runAwsE2e,
  type AwsE2eJournal,
  type AwsE2eJournalLease,
  type AwsE2eJournalStore,
} from "./aws-e2e-harness.js";
import type { CloudAdapter, CloudInventory, CloudObservation, CloudStepResult } from "./provider.js";
import { planCloudRotation } from "./rotation-plan.js";

const slot: SlotRef = {
  accountId: "123456789012",
  service: "ec2",
  region: "us-east-1",
  instanceId: "i-0123456789abcdef0",
  slotId: "public-v4",
  interfaceId: "eni-0123456789abcdef0",
  address: "198.51.100.10",
  family: 4,
};

const inventory: CloudInventory = {
  ref: slot,
  name: "acceptance-instance",
  state: "running",
  interfaces: [{
    id: slot.interfaceId,
    deviceIndex: 0,
    addresses: [{
      address: slot.address,
      family: 4,
      primary: true,
      allocationId: "eipalloc-original",
      privateAddress: "10.0.0.10",
    }],
  }],
};

const completeEnv = {
  MASTERDNS_AWS_E2E_ACCESS_KEY_ID: "temporary-access-key",
  MASTERDNS_AWS_E2E_SECRET_ACCESS_KEY: "temporary-secret",
  MASTERDNS_AWS_E2E_SESSION_TOKEN: "temporary-session-token",
  MASTERDNS_AWS_E2E_ACCOUNT_ID: slot.accountId,
  MASTERDNS_AWS_E2E_SERVICE: slot.service,
  MASTERDNS_AWS_E2E_REGION: slot.region,
  MASTERDNS_AWS_E2E_INSTANCE_ID: slot.instanceId,
  MASTERDNS_AWS_E2E_SLOT_ID: slot.slotId,
  MASTERDNS_AWS_E2E_INTERFACE_ID: slot.interfaceId,
  MASTERDNS_AWS_E2E_ADDRESS: slot.address,
  MASTERDNS_AWS_E2E_FAMILY: String(slot.family),
};

class MemoryJournal implements AwsE2eJournalStore {
  private acquired = false;
  constructor(public value?: AwsE2eJournal) {}
  async acquire(): Promise<AwsE2eJournalLease> {
    if (this.acquired) throw new Error("journal_locked");
    this.acquired = true;
    return {
      load: async () => structuredClone(this.value),
      save: async (value) => { this.value = structuredClone(value); },
      release: async () => { this.acquired = false; },
    };
  }
}

function fakeAdapter(options: {
  inspected?: CloudInventory;
  observation?: CloudObservation;
  onExecute?: (action: string) => CloudStepResult;
} = {}) {
  const executed: string[] = [];
  const observed: string[] = [];
  const adapter: CloudAdapter = {
    verifyIdentity: async () => ({ externalAccountId: slot.accountId }),
    listScopes: async () => { throw new Error("broad discovery is forbidden"); },
    discover: async () => { throw new Error("broad discovery is forbidden"); },
    inspect: async () => options.inspected ?? inventory,
    capabilities: () => ({ available: true, permission: "unverified", requiresStop: false, releasesOldAddress: false, canRestoreOldAddress: false }),
    execute: async (step) => {
      executed.push(step.action);
      return options.onExecute?.(step.action) ?? (step.action === "ec2.eip.allocate"
        ? { allocationId: "eipalloc-candidate", candidateAddress: "203.0.113.20" }
        : { candidateAddress: "203.0.113.20" });
    },
    observe: async () => "applied",
    observeDetails: async (step) => {
      observed.push(step.action);
      return options.observation ?? {
        status: "applied",
        allocationId: "eipalloc-candidate",
        candidateAddress: "203.0.113.20",
      };
    },
  };
  return { adapter, executed, observed };
}

describe("AWS E2E configuration guards", () => {
  it("reports a clear skipped result before creating an adapter when explicit credentials or scope are missing", () => {
    expect(loadAwsE2eConfig({})).toEqual({
      outcome: "skipped",
      reason: "missing required environment: MASTERDNS_AWS_E2E_ACCESS_KEY_ID, MASTERDNS_AWS_E2E_SECRET_ACCESS_KEY, MASTERDNS_AWS_E2E_SESSION_TOKEN, MASTERDNS_AWS_E2E_ACCOUNT_ID, MASTERDNS_AWS_E2E_SERVICE, MASTERDNS_AWS_E2E_REGION, MASTERDNS_AWS_E2E_INSTANCE_ID, MASTERDNS_AWS_E2E_SLOT_ID, MASTERDNS_AWS_E2E_INTERFACE_ID, MASTERDNS_AWS_E2E_ADDRESS, MASTERDNS_AWS_E2E_FAMILY",
    });
  });

  it("keeps a complete invocation read-only unless writes and a durable journal are explicitly enabled", async () => {
    const loaded = loadAwsE2eConfig(completeEnv);
    expect(loaded.outcome).toBe("ready");
    if (loaded.outcome !== "ready") throw new Error("expected ready configuration");
    const fake = fakeAdapter();

    const result = await runAwsE2e(loaded.config, { adapter: fake.adapter });

    expect(result).toMatchObject({ outcome: "read_only", scope: slot, plannedActions: ["ec2.eip.allocate", "ec2.eip.associate"] });
    expect(fake.executed).toEqual([]);
  });

  it("requires and uses exact native Lightsail names without calling broad inspection", async () => {
    const lightsailSlot: SlotRef = {
      accountId: slot.accountId,
      service: "lightsail",
      region: slot.region,
      instanceId: "arn:aws:lightsail:us-east-1:123456789012:Instance/instance-guid",
      slotId: "public-v4",
      interfaceId: "primary",
      address: slot.address,
      family: 4,
    };
    const withoutNames = loadAwsE2eConfig({
      ...completeEnv,
      MASTERDNS_AWS_E2E_SERVICE: "lightsail",
      MASTERDNS_AWS_E2E_INSTANCE_ID: lightsailSlot.instanceId,
      MASTERDNS_AWS_E2E_INTERFACE_ID: "primary",
    });
    expect(withoutNames).toEqual({
      outcome: "skipped",
      reason: "missing required environment: MASTERDNS_AWS_E2E_LIGHTSAIL_INSTANCE_NAME, MASTERDNS_AWS_E2E_LIGHTSAIL_STATIC_IP_NAME",
    });
    const loaded = loadAwsE2eConfig({
      ...completeEnv,
      MASTERDNS_AWS_E2E_SERVICE: "lightsail",
      MASTERDNS_AWS_E2E_INSTANCE_ID: lightsailSlot.instanceId,
      MASTERDNS_AWS_E2E_INTERFACE_ID: "primary",
      MASTERDNS_AWS_E2E_LIGHTSAIL_INSTANCE_NAME: "web-one",
      MASTERDNS_AWS_E2E_LIGHTSAIL_STATIC_IP_NAME: "web-static",
    });
    if (loaded.outcome !== "ready") throw new Error("expected ready configuration");
    const lightsailInventory: CloudInventory = {
      ref: lightsailSlot,
      nativeName: "web-one",
      name: "web-one",
      state: "running",
      ipv6Only: false,
      interfaces: [{ id: "primary", addresses: [{ address: slot.address, family: 4, primary: true, allocationId: "web-static", resourceId: "arn:static:web" }] }],
    };
    const fake = fakeAdapter();
    fake.adapter.inspect = async () => { throw new Error("broad inspection is forbidden"); };
    let scopedReads = 0;

    await expect(runAwsE2e(loaded.config, {
      adapter: fake.adapter,
      inspect: async () => { scopedReads++; return lightsailInventory; },
    })).resolves.toMatchObject({ outcome: "read_only", scope: lightsailSlot });
    expect(scopedReads).toBe(1);
  });

  it("requires an independently scoped Lightsail IPv4 address for an IPv6 slot", () => {
    expect(loadAwsE2eConfig({
      ...completeEnv,
      MASTERDNS_AWS_E2E_SERVICE: "lightsail",
      MASTERDNS_AWS_E2E_INSTANCE_ID: "arn:aws:lightsail:us-east-1:123456789012:Instance/instance-guid",
      MASTERDNS_AWS_E2E_INTERFACE_ID: "primary",
      MASTERDNS_AWS_E2E_ADDRESS: "2001:db8::10",
      MASTERDNS_AWS_E2E_FAMILY: "6",
      MASTERDNS_AWS_E2E_LIGHTSAIL_INSTANCE_NAME: "web-one",
      MASTERDNS_AWS_E2E_LIGHTSAIL_STATIC_IP_NAME: "none",
    })).toEqual({
      outcome: "skipped",
      reason: "missing required environment: MASTERDNS_AWS_E2E_LIGHTSAIL_IPV4_ADDRESS",
    });
  });

  it.each([
    ["instance", { ...inventory, ref: { ...inventory.ref, instanceId: "i-0fedcba9876543210" } }, "scope_instance_mismatch"],
    ["interface", { ...inventory, interfaces: [{ ...inventory.interfaces[0]!, id: "eni-unrelated" }] }, "scope_interface_mismatch"],
  ])("rejects an unrelated inspected %s before mutation", async (_label, inspected, expectedError) => {
    const loaded = loadAwsE2eConfig(completeEnv);
    if (loaded.outcome !== "ready") throw new Error("expected ready configuration");
    const fake = fakeAdapter({ inspected });

    await expect(runAwsE2e({ ...loaded.config, write: true, journalPath: "/tmp/aws-e2e.json" }, {
      adapter: fake.adapter,
      journal: new MemoryJournal(),
    })).rejects.toThrow(expectedError);
    expect(fake.executed).toEqual([]);
  });
});

describe("AWS E2E recovery", () => {
  it("observes a dispatched allocation and continues without allocating twice", async () => {
    const loaded = loadAwsE2eConfig(completeEnv);
    if (loaded.outcome !== "ready") throw new Error("expected ready configuration");
    const fake = fakeAdapter();
    const attemptId = "aws-e2e-interrupted";
    const planned = planCloudRotation(slot, inventory, { allowStop: false, attemptId });
    const journal = new MemoryJournal({
      version: 1,
      attemptId,
      scope: slot,
      original: inventory,
      phase: "running",
      steps: planned.map((step, index) => ({ step, state: index === 0 ? "dispatched" : "planned" })),
    });

    const result = await runAwsE2e({ ...loaded.config, write: true, journalPath: "/tmp/aws-e2e.json" }, {
      adapter: fake.adapter,
      journal,
    });

    expect(result.outcome).toBe("completed");
    expect(fake.observed).toEqual(["ec2.eip.allocate", "ec2.eip.associate"]);
    expect(fake.executed).toEqual(["ec2.eip.associate"]);
    expect(journal.value?.steps[0]?.observation).toMatchObject({
      status: "applied",
      allocationId: "eipalloc-candidate",
      candidateAddress: "203.0.113.20",
    });
  });

  it("retains receipts and a pending journal when remote verification times out", async () => {
    const loaded = loadAwsE2eConfig(completeEnv);
    if (loaded.outcome !== "ready") throw new Error("expected ready configuration");
    const fake = fakeAdapter({ observation: { status: "pending", allocationId: "eipalloc-candidate", candidateAddress: "203.0.113.20" } });
    const journal = new MemoryJournal();

    const result = await runAwsE2e({ ...loaded.config, write: true, journalPath: "/tmp/aws-e2e.json", observeTimeoutMs: 0 }, {
      adapter: fake.adapter,
      journal,
    });

    expect(result).toMatchObject({ outcome: "pending", action: "ec2.eip.allocate", allocationId: "eipalloc-candidate", candidateAddress: "203.0.113.20" });
    expect(journal.value?.phase).toBe("pending");
    expect(journal.value?.steps[0]).toMatchObject({ state: "pending", receipt: { allocationId: "eipalloc-candidate" } });
  });

  it("rejects a journal for a different resource before observing or executing", async () => {
    const loaded = loadAwsE2eConfig(completeEnv);
    if (loaded.outcome !== "ready") throw new Error("expected ready configuration");
    const fake = fakeAdapter();
    const wrongScope = { ...slot, instanceId: "i-0fedcba9876543210" };
    const wrongInventory = { ...inventory, ref: wrongScope };
    const journal = new MemoryJournal({
      version: 1,
      attemptId: "aws-e2e-existing",
      scope: wrongScope,
      original: wrongInventory,
      phase: "running",
      steps: planCloudRotation(wrongScope, wrongInventory, { allowStop: false, attemptId: "aws-e2e-existing" })
        .map((step) => ({ step, state: "planned" })),
    });

    await expect(runAwsE2e({ ...loaded.config, write: true, journalPath: "/tmp/aws-e2e.json" }, {
      adapter: fake.adapter,
      journal,
    })).rejects.toThrow("journal_scope_mismatch");
    expect(fake.executed).toEqual([]);
    expect(fake.observed).toEqual([]);
  });

  it("rejects a completed journal that still contains unexecuted steps", async () => {
    const loaded = loadAwsE2eConfig(completeEnv);
    if (loaded.outcome !== "ready") throw new Error("expected ready configuration");
    const fake = fakeAdapter();
    const attemptId = "aws-e2e-invalid";
    const journal = new MemoryJournal({
      version: 1,
      attemptId,
      scope: slot,
      original: inventory,
      phase: "completed",
      steps: planCloudRotation(slot, inventory, { allowStop: false, attemptId })
        .map((step) => ({ step, state: "planned" })),
    });

    await expect(runAwsE2e({ ...loaded.config, write: true, journalPath: "/tmp/aws-e2e.json" }, {
      adapter: fake.adapter,
      journal,
    })).rejects.toThrow("invalid_aws_e2e_journal");
    expect(fake.executed).toEqual([]);
    expect(fake.observed).toEqual([]);
  });

  it("rejects repeated IPv6 assignments disguised as one attempt", async () => {
    const v6Slot = { ...slot, slotId: "public-v6", address: "2001:db8::10", family: 6 as const };
    const v6Inventory: CloudInventory = {
      ...inventory,
      ref: v6Slot,
      interfaces: [{ id: v6Slot.interfaceId, deviceIndex: 0, addresses: [{ address: v6Slot.address, family: 6, primary: false }] }],
    };
    const attemptId = "aws-e2e-forged";
    const canonical = planCloudRotation(v6Slot, v6Inventory, { allowStop: false, attemptId })[0]!;
    const loaded = loadAwsE2eConfig({ ...completeEnv, MASTERDNS_AWS_E2E_SLOT_ID: v6Slot.slotId, MASTERDNS_AWS_E2E_ADDRESS: v6Slot.address, MASTERDNS_AWS_E2E_FAMILY: "6" });
    if (loaded.outcome !== "ready") throw new Error("expected ready configuration");
    const fake = fakeAdapter({ inspected: v6Inventory });
    const journal = new MemoryJournal({
      version: 1,
      attemptId,
      scope: v6Slot,
      original: v6Inventory,
      phase: "running",
      steps: [canonical, structuredClone(canonical), structuredClone(canonical)].map((step) => ({ step, state: "planned" })),
    });

    await expect(runAwsE2e({ ...loaded.config, write: true, journalPath: "/tmp/aws-e2e.json" }, {
      adapter: fake.adapter,
      journal,
    })).rejects.toThrow("invalid_aws_e2e_plan");
    expect(fake.executed).toEqual([]);
  });

  it.each([
    ["reordered actions", (steps: ReturnType<typeof planCloudRotation>) => steps.reverse()],
    ["forged step id", (steps: ReturnType<typeof planCloudRotation>) => [{ ...steps[0]!, id: "forged:0:ec2.eip.allocate" }, steps[1]!]],
    ["different before snapshot", (steps: ReturnType<typeof planCloudRotation>) => [steps[0]!, {
      ...steps[1]!, arguments: { ...steps[1]!.arguments, before: { ...inventory, name: "forged-instance" } },
    }]],
  ])("rejects a canonical plan with %s", async (_label, mutate) => {
    const loaded = loadAwsE2eConfig(completeEnv);
    if (loaded.outcome !== "ready") throw new Error("expected ready configuration");
    const fake = fakeAdapter();
    const attemptId = "aws-e2e-malformed";
    const steps = mutate(planCloudRotation(slot, inventory, { allowStop: false, attemptId }));
    const journal = new MemoryJournal({
      version: 1,
      attemptId,
      scope: slot,
      original: inventory,
      phase: "running",
      steps: steps.map((step) => ({ step, state: "planned" })),
    });

    await expect(runAwsE2e({ ...loaded.config, write: true, journalPath: "/tmp/aws-e2e.json" }, {
      adapter: fake.adapter,
      journal,
    })).rejects.toThrow("invalid_aws_e2e_plan");
    expect(fake.executed).toEqual([]);
  });

  it("rejects an applied state without a matching receipt and applied observation", async () => {
    const loaded = loadAwsE2eConfig(completeEnv);
    if (loaded.outcome !== "ready") throw new Error("expected ready configuration");
    const fake = fakeAdapter();
    const attemptId = "aws-e2e-unsupported-applied";
    const plan = planCloudRotation(slot, inventory, { allowStop: false, attemptId });
    const journal = new MemoryJournal({
      version: 1,
      attemptId,
      scope: slot,
      original: inventory,
      phase: "running",
      steps: plan.map((step, index) => ({ step, state: index === 0 ? "applied" : "planned" })),
    });

    await expect(runAwsE2e({ ...loaded.config, write: true, journalPath: "/tmp/aws-e2e.json" }, {
      adapter: fake.adapter,
      journal,
    })).rejects.toThrow("invalid_aws_e2e_journal");
    expect(fake.executed).toEqual([]);
  });

  it("does not mutate when durable intent persistence fails", async () => {
    const loaded = loadAwsE2eConfig(completeEnv);
    if (loaded.outcome !== "ready") throw new Error("expected ready configuration");
    const fake = fakeAdapter();
    const journal: AwsE2eJournalStore = {
      acquire: async () => ({
        load: async () => undefined,
        save: async () => { throw new Error("simulated_fsync_failure"); },
        release: async () => undefined,
      }),
    };

    await expect(runAwsE2e({ ...loaded.config, write: true, journalPath: "/tmp/aws-e2e.json" }, {
      adapter: fake.adapter,
      journal,
    })).rejects.toThrow("simulated_fsync_failure");
    expect(fake.executed).toEqual([]);
  });

  it.each([null, false, 0, ""])("rejects loaded JSON value %j instead of initializing a new attempt", async (loadedValue) => {
    const loaded = loadAwsE2eConfig(completeEnv);
    if (loaded.outcome !== "ready") throw new Error("expected ready configuration");
    const fake = fakeAdapter();
    let saves = 0;
    const journal: AwsE2eJournalStore = {
      acquire: async () => ({
        load: async () => loadedValue as never,
        save: async () => { saves++; },
        release: async () => undefined,
      }),
    };

    await expect(runAwsE2e({ ...loaded.config, write: true, journalPath: "/tmp/aws-e2e.json" }, {
      adapter: fake.adapter,
      journal,
    })).rejects.toThrow("invalid_aws_e2e_journal");
    expect(saves).toBe(0);
    expect(fake.executed).toEqual([]);
  });
});

describe("file AWS E2E journal ownership", () => {
  it("refuses a concurrent writer while the first lease owns the journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "masterdns-aws-e2e-"));
    const store = new FileAwsE2eJournalStore(join(directory, "journal.json"));
    const lease = await store.acquire();
    try {
      await expect(store.acquire()).rejects.toThrow("journal_locked");
    } finally {
      await lease.release();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a dead owner as stale without stealing its lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "masterdns-aws-e2e-"));
    const journalPath = join(directory, "journal.json");
    const lockPath = `${journalPath}.lock`;
    await writeFile(lockPath, JSON.stringify({ version: 1, pid: 2_147_483_647, host: hostname(), id: "dead-owner" }));
    const store = new FileAwsE2eJournalStore(journalPath);
    try {
      await expect(store.acquire()).rejects.toThrow("journal_lock_stale");
      await expect(store.acquire()).rejects.toThrow("journal_lock_stale");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows only one concurrent harness invocation to reach mutation", async () => {
    const loaded = loadAwsE2eConfig(completeEnv);
    if (loaded.outcome !== "ready") throw new Error("expected ready configuration");
    const directory = await mkdtemp(join(tmpdir(), "masterdns-aws-e2e-"));
    const journalPath = join(directory, "journal.json");
    const fake = fakeAdapter();
    let unblockFirstInspection!: () => void;
    let markFirstInspection!: () => void;
    const blocked = new Promise<void>((resolve) => { unblockFirstInspection = resolve; });
    const entered = new Promise<void>((resolve) => { markFirstInspection = resolve; });
    let first = true;
    fake.adapter.inspect = async () => {
      if (first) {
        first = false;
        markFirstInspection();
        await blocked;
      }
      return inventory;
    };
    const config = { ...loaded.config, write: true, journalPath };
    const firstRun = runAwsE2e(config, { adapter: fake.adapter });
    await entered;
    try {
      await expect(runAwsE2e(config, { adapter: fake.adapter })).rejects.toThrow("journal_locked");
      expect(fake.executed).toEqual([]);
    } finally {
      unblockFirstInspection();
    }
    await expect(firstRun).resolves.toMatchObject({ outcome: "completed" });
    expect(fake.executed).toEqual(["ec2.eip.allocate", "ec2.eip.associate"]);
    await rm(directory, { recursive: true, force: true });
  });
});
