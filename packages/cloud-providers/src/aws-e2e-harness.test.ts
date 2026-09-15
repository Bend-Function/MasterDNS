import type { SlotRef } from "@masterdns/contracts";
import { describe, expect, it } from "vitest";

import {
  loadAwsE2eConfig,
  runAwsE2e,
  type AwsE2eJournal,
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
  constructor(public value?: AwsE2eJournal) {}
  async load() { return structuredClone(this.value); }
  async save(value: AwsE2eJournal) { this.value = structuredClone(value); }
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
});
