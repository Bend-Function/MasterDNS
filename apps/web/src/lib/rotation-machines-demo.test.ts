import { expect, it } from "vitest";
import { previewRotationMachines } from "./rotation-machines-demo";

it("keeps Azure schedulable while retaining the explicit AWS and Linode incidents", () => {
  const machines = previewRotationMachines();
  const azure = machines.find(row => row.instance.service === "azure_vm" && row.slots.length)!;
  expect(azure.slots[0]!.blockedRotation).toBeNull();
  expect(azure.slots[0]!.capability).toMatchObject({ available: true, requiresStop: false });
  expect(azure.slots[0]!.capability).not.toHaveProperty("reason");
  expect(machines[0]!.slots[0]!.blockedRotation).toMatchObject({ incidentId: "rotation-01" });
  const linode = machines.find(row => row.instance.service === "linode")!;
  expect(linode.slots[0]!.blockedRotation).toMatchObject({ incidentId: "rotation-paused" });
  expect(linode.slots[0]!.capability).toMatchObject({ available: false, reason: "rotation_in_progress", requiresStop: true });
});
