import type { CloudStep, SlotRef } from "@masterdns/contracts";
import { describe, expect, it } from "vitest";

import {
  loadAwsE2eConfig,
  runAwsE2e,
  type AwsE2eJournal,
  type AwsE2eJournalLease,
  type AwsE2eJournalStore,
} from "./aws-e2e-harness.js";
import { LightsailCloudAdapter } from "./lightsail.js";
import type { CloudInventory, CloudObservation, CloudStepResult } from "./provider.js";
import { planCloudRotation } from "./rotation-plan.js";

const accountId = "123456789012";
const instanceName = "web-one";
const instanceArn = `arn:aws:lightsail:us-east-1:${accountId}:Instance/instance-guid`;
const originalAddress = "198.51.100.10";
const originalStaticName = "web-static";
const originalStaticArn = `arn:aws:lightsail:us-east-1:${accountId}:StaticIp/original-guid`;
const candidateAddress = "203.0.113.20";
const candidateArn = `arn:aws:lightsail:us-east-1:${accountId}:StaticIp/candidate-guid`;

class MemoryJournal implements AwsE2eJournalStore {
  constructor(public value?: AwsE2eJournal) {}
  async acquire(): Promise<AwsE2eJournalLease> {
    return {
      load: async () => structuredClone(this.value),
      save: async (value) => { this.value = structuredClone(value); },
      release: async () => undefined,
    };
  }
}

function fixture(origin: "static" | "dynamic", remote?: { allocated?: boolean; originalAttached?: boolean; candidateAttached?: boolean }) {
  const slot: SlotRef = {
    accountId,
    service: "lightsail",
    region: "us-east-1",
    instanceId: instanceArn,
    slotId: "public-v4",
    interfaceId: "primary",
    address: originalAddress,
    family: 4,
  };
  const original: CloudInventory = {
    ref: slot,
    nativeName: instanceName,
    name: instanceName,
    state: "running",
    ipv6Only: false,
    interfaces: [{ id: "primary", addresses: [{
      address: originalAddress,
      family: 4,
      primary: true,
      ...(origin === "static" ? { allocationId: originalStaticName, resourceId: originalStaticArn } : {}),
    }] }],
  };
  const loaded = loadAwsE2eConfig({
    MASTERDNS_AWS_E2E_ACCESS_KEY_ID: "temporary-access-key",
    MASTERDNS_AWS_E2E_SECRET_ACCESS_KEY: "temporary-secret",
    MASTERDNS_AWS_E2E_SESSION_TOKEN: "temporary-session-token",
    MASTERDNS_AWS_E2E_ACCOUNT_ID: accountId,
    MASTERDNS_AWS_E2E_SERVICE: "lightsail",
    MASTERDNS_AWS_E2E_REGION: "us-east-1",
    MASTERDNS_AWS_E2E_INSTANCE_ID: instanceArn,
    MASTERDNS_AWS_E2E_SLOT_ID: "public-v4",
    MASTERDNS_AWS_E2E_INTERFACE_ID: "primary",
    MASTERDNS_AWS_E2E_ADDRESS: originalAddress,
    MASTERDNS_AWS_E2E_FAMILY: "4",
    MASTERDNS_AWS_E2E_LIGHTSAIL_INSTANCE_NAME: instanceName,
    MASTERDNS_AWS_E2E_LIGHTSAIL_STATIC_IP_NAME: origin === "static" ? originalStaticName : "none",
  });
  if (loaded.outcome !== "ready") throw new Error("expected ready configuration");

  let allocated = remote?.allocated ?? false;
  let originalAttached = remote?.originalAttached ?? origin === "static";
  let candidateAttached = remote?.candidateAttached ?? false;
  let candidateName: string | undefined = allocated ? "masterdns-aws-e2e-restart" : undefined;
  const writes: string[] = [];
  const requests: string[] = [];
  const adapter = new LightsailCloudAdapter(accountId, loaded.config.credentials, {
    stsSend: async () => ({ Account: accountId }),
    lightsailSend: async (command) => {
      const action = command.constructor.name;
      requests.push(action);
      if (action === "GetInstanceCommand") return { instance: {
        name: instanceName,
        arn: instanceArn,
        state: { name: "running" },
        ipAddressType: "ipv4",
        isStaticIp: candidateAttached || originalAttached,
        publicIpAddress: candidateAttached ? candidateAddress : originalAttached ? originalAddress : origin === "dynamic" ? originalAddress : "198.51.100.77",
      } };
      if (action === "GetStaticIpCommand") {
        if (command.input.staticIpName === originalStaticName && origin === "static") return { staticIp: {
          name: originalStaticName,
          arn: originalStaticArn,
          ipAddress: originalAddress,
          ...(originalAttached ? { attachedTo: instanceName } : {}),
        } };
        if (command.input.staticIpName === candidateName && allocated) return { staticIp: {
          name: candidateName,
          arn: candidateArn,
          ipAddress: candidateAddress,
          ...(candidateAttached ? { attachedTo: instanceName } : {}),
        } };
        throw Object.assign(new Error("missing"), { name: "NotFoundException" });
      }
      if (action === "GetOperationCommand") return { operation: {
        id: command.input.operationId,
        status: "Succeeded",
        resourceName: command.input.operationId === "allocate" ? candidateName
          : command.input.operationId === "detach" ? originalStaticName : instanceName,
      } };
      writes.push(action);
      if (action === "AllocateStaticIpCommand") {
        candidateName = command.input.staticIpName;
        allocated = true;
        return { operations: [{ id: "allocate", status: "Started" }] };
      }
      if (action === "DetachStaticIpCommand") {
        originalAttached = false;
        return { operations: [{ id: "detach", status: "Started" }] };
      }
      if (action === "AttachStaticIpCommand") {
        candidateAttached = true;
        return { operations: [{ id: "attach", status: "Started" }] };
      }
      throw new Error(`unexpected command ${action}`);
    },
  });
  return { adapter, config: { ...loaded.config, write: true, journalPath: "/tmp/aws-e2e-lightsail.json" }, original, slot, writes, requests };
}

function allocationEvidence(): { receipt: CloudStepResult; observation: CloudObservation } {
  const receipt = {
    allocationId: "masterdns-aws-e2e-restart",
    resourceId: candidateArn,
    candidateAddress,
    operationId: "allocate",
    operationIds: ["allocate"],
    before: { state: "before" },
    after: { state: "after" },
  };
  return { receipt, observation: { ...receipt, status: "applied" } };
}

function detachEvidence(): { receipt: CloudStepResult; observation: CloudObservation } {
  const receipt = {
    remoteId: originalStaticName,
    resourceId: originalStaticArn,
    operationId: "detach",
    operationIds: ["detach"],
    before: { state: "before" },
    after: { state: "after" },
  };
  return { receipt, observation: { ...receipt, status: "applied" } };
}

function restartJournal(original: CloudInventory, slot: SlotRef, active: "detach" | "attach"): AwsE2eJournal {
  const attemptId = "aws-e2e-restart";
  const steps = planCloudRotation(slot, original, { allowStop: false, attemptId });
  const allocation = allocationEvidence();
  steps[0]!.arguments.receipt = structuredClone(allocation.receipt);
  for (const step of steps.slice(1)) step.arguments.candidateReceipt = structuredClone(allocation.receipt);
  const entries: AwsE2eJournal["steps"] = [
    { step: steps[0]!, state: "applied", ...allocation },
  ];
  if (active === "detach") {
    entries.push({ step: steps[1]!, state: "dispatched" }, { step: steps[2]!, state: "planned" });
  } else {
    const detach = detachEvidence();
    steps[1]!.arguments.receipt = structuredClone(detach.receipt);
    entries.push({ step: steps[1]!, state: "applied", ...detach }, { step: steps[2]!, state: "dispatched" });
  }
  return {
    version: 1,
    attemptId,
    scope: slot,
    lightsailScope: { instanceName, staticIpName: originalStaticName },
    original,
    phase: "running",
    steps: entries,
  };
}

describe("AWS E2E Lightsail transitions", () => {
  it.each(["static", "dynamic"] as const)("completes an exact %s-origin plan without broad discovery", async (origin) => {
    const test = fixture(origin);

    await expect(runAwsE2e(test.config, { adapter: test.adapter, journal: new MemoryJournal() }))
      .resolves.toMatchObject({ outcome: "completed", candidateAddress });
    expect(test.writes).toEqual(origin === "static"
      ? ["AllocateStaticIpCommand", "DetachStaticIpCommand", "AttachStaticIpCommand"]
      : ["AllocateStaticIpCommand", "AttachStaticIpCommand"]);
    expect(test.requests).not.toContain("GetInstancesCommand");
    expect(test.requests).not.toContain("GetStaticIpsCommand");
  });

  it.each(["detach", "attach"] as const)("resumes a dispatched %s through exact scoped reads", async (active) => {
    const test = fixture("static", {
      allocated: true,
      originalAttached: false,
      candidateAttached: active === "attach",
    });
    const journal = new MemoryJournal(restartJournal(test.original, test.slot, active));

    await expect(runAwsE2e(test.config, { adapter: test.adapter, journal }))
      .resolves.toMatchObject({ outcome: "completed", candidateAddress });
    expect(test.writes).toEqual(active === "detach" ? ["AttachStaticIpCommand"] : []);
    expect(test.requests).not.toContain("GetInstancesCommand");
    expect(test.requests).not.toContain("GetStaticIpsCommand");
  });

  it("restarts a completed dynamic-origin plan against only its journal candidate", async () => {
    const test = fixture("dynamic");
    const journal = new MemoryJournal();
    await runAwsE2e(test.config, { adapter: test.adapter, journal });
    const writes = [...test.writes];

    await expect(runAwsE2e(test.config, { adapter: test.adapter, journal }))
      .resolves.toMatchObject({ outcome: "completed", candidateAddress });
    expect(test.writes).toEqual(writes);
    expect(test.requests).not.toContain("GetInstancesCommand");
    expect(test.requests).not.toContain("GetStaticIpsCommand");
  });

  it("rejects a forged candidate name before scoped inspection", async () => {
    const test = fixture("static", { allocated: true, originalAttached: false });
    const value = restartJournal(test.original, test.slot, "detach");
    const forged = { ...value.steps[0]!.receipt!, allocationId: "foreign-static" };
    value.steps[0]!.receipt = forged;
    value.steps[0]!.observation = { ...value.steps[0]!.observation!, allocationId: "foreign-static" };
    value.steps[0]!.step.arguments.receipt = structuredClone(forged);
    for (const entry of value.steps.slice(1)) entry.step.arguments.candidateReceipt = structuredClone(forged);

    await expect(runAwsE2e(test.config, { adapter: test.adapter, journal: new MemoryJournal(value) }))
      .rejects.toThrow("invalid_aws_e2e_journal");
    expect(test.requests).toEqual([]);
    expect(test.writes).toEqual([]);
  });
});
