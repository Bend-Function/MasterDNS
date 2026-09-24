import { describe, expect, it } from "vitest";
import { demoCloudAccounts, demoCloudInstances, demoCloudSlots } from "./cloud-demo";
import { demoRotationPolicy } from "./rotation-demo";
import { createRotationRefreshGate, familyControl, loadRotationMachines, machineMatches, machinePolicySummary, mergeMachinePolicies, policyToggleInput, rotationSlotBlock, updateMachinePolicy, type RotationMachine } from "./rotation-machines";

const machine = (): RotationMachine => ({ ...demoCloudInstances[0]!, slots: demoCloudSlots.map(slot => ({ ...slot, policy: { ...demoRotationPolicy, slotId: slot.slot.id, enabled: slot.slot.family === "4" } })) });

describe("rotation machine overview", () => {
  it("defers and coalesces background refresh until both saving and editing have ended", () => {
    const gate = createRotationRefreshGate(); let reads = 0;
    gate.hold("save"); gate.hold("editor");
    gate.request(() => { reads++; }); gate.request(() => { reads++; });
    gate.release("save"); expect(reads).toBe(0);
    gate.release("editor"); expect(reads).toBe(1);
    gate.hold("save"); gate.request(() => { reads++; }); gate.cancel(); gate.release("save");
    expect(reads).toBe(1);
  });

  it("cannot let an older list read overwrite a successfully saved switch", () => {
    const old = [machine()];
    const saved = updateMachinePolicy(old, { ...demoRotationPolicy, revision: 3, enabled: false });
    expect(mergeMachinePolicies(old, saved)[0]!.slots[0]!.policy).toMatchObject({ revision: 3, enabled: false });
  });
  it("requires expansion for multiple slots and never chooses an arbitrary target", () => {
    const row = machine();
    expect(familyControl(row, "4").kind).toBe("single");
    row.slots.push({ ...row.slots[0]!, slot: { ...row.slots[0]!.slot, id: "other" } });
    expect(familyControl(row, "4")).toMatchObject({ kind: "multiple", enabled: 2 });
    expect(familyControl({ ...row, slots: [] }, "4").kind).toBe("empty");
  });

  it("reports missing policies as unknown and prevents enabling absent or disabled machines", () => {
    const row = machine(), slot = row.slots[0]!;
    expect(familyControl({ ...row, slots: [{ ...slot, policy: null, policyError: "加载失败" }] }, "4").kind).toBe("unknown");
    expect(machinePolicySummary({ ...row, slots: [{ ...slot, policy: null }] })).toContain("未完整读取");
    expect(rotationSlotBlock({ ...row, account: { ...row.account!, enabled: false } }, slot)).toContain("账号");
    expect(rotationSlotBlock({ ...row, instance: { ...row.instance, metadata: { present: false } } }, slot)).toContain("不存在");
    expect(rotationSlotBlock({ ...row, authorization: null }, slot)).toContain("授权");
  });

  it("only changes enabled and retains the saved policy revision and every tuning parameter", () => {
    const policy = { ...demoRotationPolicy, maxAttempts: 7, minIntervalSeconds: 300, cloudWaitSeconds: 45, candidateWindowSeconds: 900 };
    expect(policyToggleInput(policy, false)).toEqual({ revision: policy.revision, enabled: false, maxAttempts: 7, minIntervalSeconds: 300, cloudWaitSeconds: 45, candidateWindowSeconds: 900 });
    const rows = [machine()];
    const updated = updateMachinePolicy(rows, { ...policy, enabled: false, revision: policy.revision + 1 });
    expect(updated[0]!.slots[0]!.policy?.enabled).toBe(false);
    expect(updateMachinePolicy(updated, policy)[0]!.slots[0]!.policy?.enabled).toBe(false);
    expect(updated[0]!.slots[1]).toEqual(rows[0]!.slots[1]);
  });

  it("searches IPs and keeps unauthorized and unsupported machines visible by default", () => {
    const row = machine();
    expect(machineMatches(row, { search: "203.0.113.18", account: "", region: "", status: "" })).toBe(true);
    expect(machineMatches({ ...row, authorization: null }, { search: "", account: "", region: "", status: "" })).toBe(true);
    expect(machineMatches(row, { search: "", account: "other", region: "", status: "" })).toBe(false);
    expect(machineMatches(row, { search: "", account: "", region: "", status: "enabled" })).toBe(true);
  });

  it("keeps successful accounts and machines when another account or slot policy fails", async () => {
    const accounts = [...demoCloudAccounts, { ...demoCloudAccounts[0]!, id: "unavailable", name: "Unavailable" }];
    const result = await loadRotationMachines(async <T>(path: string): Promise<T> => {
      if (path === "/v1/cloud-accounts") return accounts as T;
      if (path.includes("unavailable")) throw new Error("offline");
      if (path.endsWith("/instances")) return demoCloudInstances as T;
      if (path.startsWith("/v1/address-slots")) return demoCloudSlots as T;
      if (path.includes("slot-v6")) throw new Error("policy error");
      return demoRotationPolicy as T;
    });
    expect(result.rows).toHaveLength(1);
    expect(result.errors.join()).toContain("Unavailable");
    expect(result.rows[0]!.slots[0]!.policy?.enabled).toBe(true);
    expect(result.rows[0]!.slots[1]!.policy).toBeNull();
    expect(result.rows[0]!.slots[1]!.policyError).toBeTruthy();
  });

  it("bounds reads and stops scheduling more requests after invalidation", async () => {
    let active = 0, peak = 0, keepLoading = true;
    const accounts = Array.from({ length: 12 }, (_, i) => ({ ...demoCloudAccounts[0]!, id: String(i) }));
    const result = await loadRotationMachines(async <T>(path: string): Promise<T> => {
      if (path === "/v1/cloud-accounts") return accounts as T;
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--; keepLoading = false;
      return demoCloudInstances as T;
    }, () => keepLoading);
    expect(peak).toBeLessThanOrEqual(4);
    expect(result.rows.length).toBeLessThanOrEqual(4);
  });
});
