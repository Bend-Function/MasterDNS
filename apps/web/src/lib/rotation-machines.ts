import type { RotationPolicyInput } from "@masterdns/contracts/rotation";
import type { AddressSlot, CloudAccount, CloudInstanceRow } from "./cloud-types";
import { cloudInstanceMatches, cloudRotationBlock, cloudErrorMessage } from "./cloud-ui";
import type { RotationPolicy } from "./rotation-types";

export type MachineSlot = AddressSlot & { policy: RotationPolicy | null; policyError?: string | undefined };
export type RotationMachine = CloudInstanceRow & { slots: MachineSlot[]; loadError?: string };
export type MachineFilters = { search: string; account: string; region: string; status: string };

export function createRotationRefreshGate() {
  const holds = new Set<string>(); let queued: (() => void) | null = null;
  return {
    hold(key: string) { holds.add(key); },
    request(refresh: () => void) { if (holds.size) queued = refresh; else refresh(); },
    release(key: string) { holds.delete(key); if (!holds.size && queued) { const refresh = queued; queued = null; refresh(); } },
    cancel() { queued = null; },
  };
}

export function mergeMachinePolicies(incoming: RotationMachine[], previous: RotationMachine[]): RotationMachine[] {
  const saved = new Map(previous.flatMap(row => row.slots.filter(entry => entry.policy).map(entry => [entry.slot.id, entry.policy!] as const)));
  return incoming.map(row => ({ ...row, slots: row.slots.map(entry => {
    const policy = saved.get(entry.slot.id);
    return policy && entry.policy && policy.revision > entry.policy.revision ? { ...entry, policy } : entry;
  }) }));
}

export function machinePolicySummary(row: RotationMachine): string {
  if (row.loadError || row.slots.some(slot => !slot.policy)) return "策略状态未完整读取";
  if (!row.slots.length) return "暂无地址槽位";
  return row.slots.some(slot => slot.policy?.enabled) ? "故障轮换已开启" : "故障轮换未开启";
}

export function rotationSlotBlock(row: CloudInstanceRow, slot: AddressSlot): string | null {
  if (!row.account?.enabled) return "云账号已停用";
  if (row.instance.metadata.present === false || row.inventory?.status === "absent") return "云实例已不存在";
  if (!row.inScope) return "实例已不在管理范围内";
  if (slot.isCurrent === false) return "历史地址槽位，不能开启轮换";
  return cloudRotationBlock(slot, row.authorization);
}

export function familyControl(row: RotationMachine, family: "4" | "6") {
  const slots = row.slots.filter(entry => entry.slot.family === family);
  if (row.loadError) return { kind: "unknown" as const, slots, enabled: 0 };
  if (!slots.length) return { kind: "empty" as const, slots, enabled: 0 };
  const enabled = slots.filter(entry => entry.policy?.enabled).length;
  if (slots.length > 1) return { kind: "multiple" as const, slots, enabled };
  return { kind: slots[0]!.policy ? "single" as const : "unknown" as const, slots, enabled };
}

export function policyToggleInput(policy: RotationPolicy, enabled: boolean): RotationPolicyInput {
  return { enabled, revision: policy.revision, maxAttempts: policy.maxAttempts, minIntervalSeconds: policy.minIntervalSeconds, cloudWaitSeconds: policy.cloudWaitSeconds, candidateWindowSeconds: policy.candidateWindowSeconds };
}

export function updateMachinePolicy(rows: RotationMachine[], policy: RotationPolicy): RotationMachine[] {
  return rows.map(row => ({ ...row, slots: row.slots.map(entry => entry.slot.id === policy.slotId && (!entry.policy || entry.policy.revision <= policy.revision) ? { ...entry, policy, policyError: undefined } : entry) }));
}

export function machineMatches(row: RotationMachine, filters: MachineFilters): boolean {
  if (filters.account && filters.account !== row.instance.accountId) return false;
  if (filters.region && filters.region !== row.instance.region) return false;
  if (!cloudInstanceMatches(row, filters.search.trim())) return false;
  if (filters.status === "enabled") return row.slots.some(entry => entry.policy?.enabled);
  if (filters.status === "disabled") return !row.loadError && row.slots.length > 0 && row.slots.every(entry => entry.policy && !entry.policy.enabled);
  if (filters.status === "attention") return Boolean(row.loadError || !row.slots.length || row.slots.some(entry => !entry.policy || rotationSlotBlock(row, entry)));
  if (filters.status === "rotating") return row.slots.some(entry => entry.blockedRotation);
  return true;
}

/** Reads saved inventory only. Four request lanes; one failed account/slot never hides the rest. */
export async function loadRotationMachines(request: <T>(path: string) => Promise<T>, current: () => boolean = () => true): Promise<{ rows: RotationMachine[]; errors: string[] }> {
  const accounts = await request<CloudAccount[]>("/v1/cloud-accounts");
  const errors: string[] = [];
  const groups = await bounded(accounts, async account => {
    try { return (await request<CloudInstanceRow[]>(`/v1/cloud-accounts/${account.id}/instances`)).map(row => ({ ...row, account })); }
    catch (error) { errors.push(`${account.name}：${cloudErrorMessage(error, "机器清单加载失败")}`); return []; }
  }, current);
  const rows = await bounded(groups.flat(), async row => {
    try {
      const slots = await request<AddressSlot[]>(`/v1/address-slots?instanceId=${encodeURIComponent(row.instance.id)}`);
      const loaded: MachineSlot[] = [];
      for (const slot of slots) {
        if (!current()) break;
        try { loaded.push({ ...slot, policy: await request<RotationPolicy>(`/v1/rotation-policies?slotId=${encodeURIComponent(slot.slot.id)}`) }); }
        catch (error) { loaded.push({ ...slot, policy: null, policyError: cloudErrorMessage(error, "策略加载失败") }); }
      }
      return { ...row, slots: loaded };
    } catch (error) { return { ...row, slots: [], loadError: cloudErrorMessage(error, "地址槽位加载失败") }; }
  }, current);
  return { rows, errors };
}

async function bounded<T, R>(items: T[], work: (item: T) => Promise<R>, current: () => boolean): Promise<R[]> {
  const result: R[] = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (current() && next < items.length) { const index = next++; result[index] = await work(items[index]!); }
  }));
  return result.filter((item): item is R => item !== undefined);
}
