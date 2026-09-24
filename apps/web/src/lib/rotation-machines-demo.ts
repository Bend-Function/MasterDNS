import { demoCloudInstances, demoCloudSlots } from "./cloud-demo";
import { demoRotationPolicy } from "./rotation-demo";
import type { RotationMachine } from "./rotation-machines";

/** Isolated UI preview fixtures; never used by the live inventory loader. */
export function previewRotationMachines(): RotationMachine[] {
  const base = demoCloudInstances[0]!;
  const first: RotationMachine = { ...base, slots: demoCloudSlots.map(slot => ({ ...slot, policy: { ...demoRotationPolicy, slotId: slot.slot.id, enabled: slot.slot.family === "4" } })) };
  const clone = (id: string, name: string, region: string): RotationMachine => {
    const instance = { ...base.instance, id, externalId: `i-preview-${id}`, name, region };
    const slots = first.slots.map(entry => {
      const slot = { ...entry.slot, id: `${id}-${entry.slot.family}` };
      return { ...entry, slot, ref: { ...entry.ref!, slotId: slot.id, instanceId: instance.externalId, region }, cloudTarget: { ...entry.cloudTarget!, instance, slot: { ...entry.cloudTarget!.slot, id: slot.id } }, policy: { ...entry.policy!, slotId: slot.id, enabled: false } };
    });
    return { ...base, instance, authorization: { ...base.authorization!, instanceId: id }, slots };
  };
  const unauthorized = { ...clone("tokyo", "edge-tokyo-02", "ap-northeast-1"), authorization: null };
  const multi = clone("singapore", "edge-singapore-03", "ap-southeast-1");
  const extra = multi.slots[0]!;
  multi.slots.push({ ...extra, slot: { ...extra.slot, id: "singapore-extra", name: "secondary-v4", interfaceId: "interface-2" }, currentAddress: { ...extra.currentAddress!, id: "secondary-address", address: "203.0.113.36" }, ref: { ...extra.ref!, slotId: "singapore-extra", interfaceId: "eni-secondary", address: "203.0.113.36" }, cloudTarget: null, policy: { ...extra.policy!, slotId: "singapore-extra" } });
  multi.addresses = [...(multi.addresses ?? []), multi.slots[2]!.currentAddress!];
  const empty = clone("sydney", "edge-sydney-04", "australiaeast");
  empty.instance = { ...empty.instance, accountId: "azure-preview", service: "azure_vm", externalId: "vm-sydney-04" };
  empty.account = { ...base.account!, id: "azure-preview", name: "Azure Development", provider: "azure", enabled: false };
  empty.slots = []; empty.addresses = [];
  first.slots = first.slots.map(slot => ({ ...slot, blockedRotation: { incidentId: "rotation-01", reason: "rotation_in_progress" }, capability: slot.capability ? { ...slot.capability, available: false, reason: "rotation_in_progress" } : null }));
  return [first, unauthorized, multi, empty];
}
