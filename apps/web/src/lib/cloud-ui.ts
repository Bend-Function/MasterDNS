import type { AddressSlot, AuthorizationPayload, CloudAuthorization } from "./cloud-types";
import type { IntentKey } from "./intent-key";

type SlotContext = { accountEnabled: boolean; instancePresent: boolean; managed: boolean };

export function selectableCloudSlots(recordType: "A" | "AAAA", slots: AddressSlot[], context: SlotContext = { accountEnabled: true, instancePresent: true, managed: true }) {
  const family = recordType === "A" ? "4" : "6";
  if (!context.accountEnabled || !context.instancePresent || !context.managed) return [];
  return slots.filter((entry) => entry.slot.family === family && entry.inScope && entry.currentAddress !== null && entry.capability?.available === true);
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
