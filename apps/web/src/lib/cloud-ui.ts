import { ApiError } from "./api";
import type { AddressSlot, AuthorizationPayload, CloudAccount, CloudAddress, CloudAuthorization, CloudInstanceRow, CloudScope } from "./cloud-types";
import type { IntentKey } from "./intent-key";

type SlotContext = { accountEnabled: boolean; instancePresent: boolean; managed: boolean };

export function selectableCloudSlots(recordType: "A" | "AAAA", slots: AddressSlot[], context: SlotContext = { accountEnabled: true, instancePresent: true, managed: true }) {
  const family = recordType === "A" ? "4" : "6";
  if (!context.accountEnabled || !context.instancePresent || !context.managed) return [];
  return slots.filter((entry) => entry.slot.family === family && entry.inScope && entry.currentAddress !== null);
}

export function slotsMatchingExistingRecord(recordType: "A" | "AAAA", address: string, slots: AddressSlot[]) {
  return selectableCloudSlots(recordType, slots).filter((entry) => entry.currentAddress !== null && sameIpAddress(entry.currentAddress.address, address));
}

export async function loadCloudScopes(accounts: Array<Pick<CloudAccount, "id">>, fetchScopes: (accountId: string) => Promise<CloudScope[]>) {
  const results = await Promise.allSettled(accounts.map(async (account) => [account.id, await fetchScopes(account.id)] as const));
  const scopes: Record<string, CloudScope[]> = {};
  const errors: Record<string, string> = {};
  results.forEach((result, index) => {
    const account = accounts[index];
    if (!account) return;
    if (result.status === "fulfilled") scopes[result.value[0]] = result.value[1];
    else errors[account.id] = errorMessage(result.reason);
  });
  return { scopes, errors };
}

export async function loadVisibleInstanceAddresses(rows: CloudInstanceRow[], limit: number, fetchAddresses: (instanceId: string) => Promise<CloudAddress[]>) {
  const visible = rows.slice(0, limit);
  const results = await Promise.allSettled(visible.map(async (row) => [row.instance.id, await fetchAddresses(row.instance.id)] as const));
  const addresses: Record<string, CloudAddress[]> = {};
  const errors: Record<string, string> = {};
  results.forEach((result, index) => {
    const row = visible[index];
    if (!row) return;
    if (result.status === "fulfilled") addresses[result.value[0]] = result.value[1];
    else errors[row.instance.id] = errorMessage(result.reason);
  });
  return { addresses, errors };
}
export function authorizationPayload(value: CloudAuthorization): AuthorizationPayload {
  return {
    revision: value.revision,
    managed: value.managed,
    allowIpv4Rotation: value.allowIpv4Rotation,
    allowIpv6Rotation: value.allowIpv6Rotation,
    allowStopStart: value.allowStopStart,
    allowReleaseAddress: value.allowReleaseAddress,
  };
}

export async function submitCloudIntent<T>(intent: IntentKey, request: (key: string) => Promise<T>): Promise<T> {
  const result = await request(intent.current());
  intent.reset();
  return result;
}

function sameIpAddress(left: string, right: string) {
  if (left.includes(":") !== right.includes(":")) return false;
  if (!left.includes(":")) return left === right;
  try { return new URL(`http://[${left}]/`).hostname === new URL(`http://[${right}]/`).hostname; }
  catch { return false; }
}

const errorMessage = (value: unknown) => value instanceof Error ? value.message : "加载失败";

export const cloudProviderLabels = { aws: "AWS", azure: "Microsoft Azure", linode: "Linode / Akamai Cloud" } as const;
export const cloudScopeExamples = { aws: "ap-southeast-2, us-west-2", azure: "australiaeast, westus2", linode: "us-east, ap-south" } as const;
export function cloudServiceLabel(service: import("@masterdns/contracts/cloud").CloudService) {
  return { ec2: "Amazon EC2", lightsail: "Amazon Lightsail", azure_vm: "Azure Virtual Machine", linode: "Linode" }[service];
}
export function capabilityReason(reason?: string) {
  return ({
    inventory_mismatch: "清单身份不匹配", interface_not_found: "网卡已不存在", address_not_found: "地址已不存在", lightsail_ipv6_only: "IPv6-only 套餐不支持", secondary_interface_unsupported: "不支持次要网卡", primary_ipv6_immutable: "Primary IPv6 不可轮换，可绑定与监控",
    linode_slaac_ipv6_immutable: "Linode SLAAC IPv6 为硬件派生地址，不可轮换；可绑定与监控",
    linode_network_helper_required: "需要在唯一旧版配置中预先启用 Network Helper；MasterDNS 不会自动修改网络配置",
    linode_boot_config_ambiguous: "仅支持一个明确的旧版启动配置，当前配置数量或身份不明确",
    linode_new_interfaces_unsupported: "新版 Linode Interfaces 不支持轮换；已发现的主机地址可绑定与监控",
    linode_public_config_required: "需要简单的旧版公网接口；VLAN、VPC 或多接口配置不支持轮换",
    linode_advanced_networking_unsupported: "共享 IPv4 或高级网络配置不支持轮换",
    linode_boot_mode_unsupported: "仅支持 default 启动模式", linode_not_running: "Linode 必须处于运行状态",
    linode_event_observation_required: "无法确认重启事件或账号身份；需要可读取事件的凭证",
    linode_permissions_required: "需要 Linode 读写、IP 读取和事件读取权限；有效用户权限仍需云端确认",
    linode_address_ownership_unknown: "地址归属证据不完整", linode_reserved_ipv4_lifecycle_unsupported: "Reserved IPv4 生命周期不支持轮换",
    vm_topology_or_state_unsupported: "Azure VM 拓扑或运行状态不支持；需运行中的独立 VM",
    nic_topology_or_ownership_unsupported: "Azure NIC 配置、关联拓扑或归属不支持；需精确的现有 IP 配置",
    public_ip_topology_unsupported: "Azure 公网 IP 的 SKU、分配方式或关联拓扑不支持",
    unsupported_topology: "当前云网络拓扑不支持轮换，已发现的主机地址仍可绑定与监控",
    quota_exceeded: "云端地址配额不足；Linode 额外 IPv4 需要支持团队批准配额并产生费用",
    cleanup_health_failed: "清理重启后探测未恢复", probe_insufficient: "外部探测证据不足，等待达到健康判定阈值",
    permission_denied: "云端拒绝访问，请检查凭证的有效权限", stop_start_not_authorized: "尚未授权停止、启动或重启实例",
  } as Record<string, string>)[reason ?? ""] ?? reason ?? "未返回技术能力";
}
export function cloudRotationBlock(slot: AddressSlot, authorization: CloudAuthorization | null): string | null {
  if (!slot.inScope) return "槽位已不在管理范围内";
  if (!slot.capability?.available) return capabilityReason(slot.capability?.reason);
  if (!authorization?.managed) return "实例尚未授权 MasterDNS 管理";
  if (!(slot.slot.family === "4" ? authorization.allowIpv4Rotation : authorization.allowIpv6Rotation)) return `IPv${slot.slot.family} 自动轮换未获授权`;
  if (slot.capability.requiresStop && !authorization.allowStopStart) return "该槽位换址需要停止、启动或重启实例，请先授予停机权限";
  return null;
}
export function rotationDowntimeNotice(slot: AddressSlot, releaseAuthorized: boolean): string | null {
  if (!slot.capability?.requiresStop) return null;
  if (slot.ref?.service === "linode") return `Linode 换址将重启实例，使 Network Helper 应用新 IPv4，期间服务会中断。${releaseAuthorized ? "已授权释放用户原有 IPv4，DNS 发布并满足清理条件后，清理还会再次重启实例。" : "未授权释放用户原有 IPv4。"}此释放开关仅控制用户原有地址；系统创建的地址（包括失败候选和后续换下的旧地址）仍可自动清理，在停机授权有效时可能导致多次额外重启和服务中断。额外 IPv4 需获批配额并产生费用。`;
  return "该槽位换址需要停止并启动或重启实例，期间服务会中断。";
}

export function cloudErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof ApiError) {
    const explanation = capabilityReason(value.code);
    if (explanation !== value.code) return explanation;
  }
  return value instanceof Error ? value.message : fallback;
}
