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
