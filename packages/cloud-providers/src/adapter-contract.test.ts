import type { CloudStep } from "@masterdns/contracts";
import { describe, expect, it } from "vitest";
import {
  evaluateCapabilities, getCloudServiceRegistration, hasCloudIdleIps, hasCloudLifecycle, hasCloudRotation, hasCloudTraffic,
  planCloudRotation, requireCloudRotation,
} from "./index.js";
import { adapterContractCases, type AdapterContractCase } from "./adapter-contract-fixtures.js";
import type { CloudInventory } from "./provider.js";

/** Project only shared fields: provider-specific security evidence remains in full inventory for planning. */
function normalizedInventory(inventory: CloudInventory): CloudInventory {
  const { metadata: _metadata, interfaces, ...instance } = inventory;
  return {
    ...instance,
    interfaces: interfaces.map(({ metadata: _interfaceMetadata, addresses, ...networkInterface }) => ({
      ...networkInterface,
      addresses: addresses.map(({ metadata: _addressMetadata, ...address }) => address),
    })),
  };
}

/** Reuse with a new service's real factory, boundary fixture, and independent literal expectations. */
export function describeAdapterContract(contract: AdapterContractCase): void {
  describe(`${contract.name ?? contract.service} adapter behavior contract`, () => {
    it("verifies remote identity and returns the declared geographic scopes", async () => {
      const fixture = contract.create();
      expect(await fixture.adapter.verifyIdentity()).toEqual({ externalAccountId: contract.identity });
      expect(await fixture.adapter.listScopes()).toEqual(contract.scopes);
      expect(fixture.requests.length).toBeGreaterThan(0);
      expect(fixture.unexpectedRequests).toEqual([]);
    });

    it("normalizes discovery and inspection with stable resource and address identities", async () => {
      const fixture = contract.create();
      const page = await fixture.adapter.discover(contract.inventory.ref.region);
      expect(page.cursor).toBeUndefined();
      expect(page.items.map(normalizedInventory)).toEqual([contract.inventory]);
      expect(normalizedInventory(await fixture.adapter.inspect(contract.inventory.ref))).toEqual(contract.inventory);
      expect(fixture.unexpectedRequests).toEqual([]);
    });

    it.each(["account", "service"] as const)("rejects a foreign %s reference before accessing the transport", async field => {
      const fixture = contract.create();
      const ref = { ...contract.inventory.ref };
      if (field === "account") ref.accountId = "another-local-account";
      else ref.service = contract.service === "ec2" ? "lightsail" : "ec2";
      // Existing providers deliberately distinguish not-found, ambiguous ownership and changed identity.
      await expect(fixture.adapter.inspect(ref)).rejects.toMatchObject({ code: contract.foreignRefError, retryable: false });
      expect(fixture.requests).toEqual([]);
      expect(fixture.unexpectedRequests).toEqual([]);
    });

    it("supports repeatable reads without cloud mutations or shared response objects", async () => {
      const fixture = contract.create();
      const first = await fixture.adapter.inspect(contract.inventory.ref);
      const original = structuredClone(first);
      const page = await fixture.adapter.discover(contract.inventory.ref.region);
      expect(page.items).toEqual([original]);
      // Consumer edits must not contaminate later snapshots (including in-memory SDK responses).
      first.interfaces[0]!.addresses[0]!.address = "consumer-edited-value";
      first.interfaces.length = 0;
      expect(await fixture.adapter.inspect(contract.inventory.ref)).toEqual(original);
      expect(await fixture.adapter.discover(contract.inventory.ref.region)).toEqual({ items: [original] });
      expect(fixture.unexpectedRequests).toEqual([]);
    });

    it("declares complete rotation and optional capabilities without advertising unsupported idle IP methods", () => {
      const { adapter, requests } = contract.create();
      expect(hasCloudRotation(adapter)).toBe(contract.rotation !== false);
      if (contract.rotation) expect(requireCloudRotation(adapter)).toBe(adapter);
      else {
        expect(adapter.execute).toBeUndefined();
        expect(adapter.observe).toBeUndefined();
        expect(() => requireCloudRotation(adapter)).toThrow(expect.objectContaining({ code: "rotation_unsupported", reason: "rotation_unavailable" }));
      }
      expect(hasCloudLifecycle(adapter)).toBe(contract.optional.lifecycle);
      expect(hasCloudTraffic(adapter)).toBe(contract.optional.traffic);
      if (!contract.optional.lifecycle) {
        expect(adapter.inspectLifecycle).toBeUndefined();
        expect(adapter.mutateLifecycle).toBeUndefined();
      }
      if (!contract.optional.traffic) expect(adapter.monthlyTraffic).toBeUndefined();
      expect(hasCloudIdleIps(adapter)).toBe(contract.optional.idleIps);
      if (!contract.optional.idleIps) {
        expect(adapter.listIdleStaticIps).toBeUndefined();
        expect(adapter.releaseIdleStaticIp).toBeUndefined();
      }
      expect(requests).toEqual([]);
    });

    it("dispatches registered capabilities and plans against real normalized inventory", async () => {
      const fixture = contract.create();
      const inventory = await fixture.adapter.inspect(contract.inventory.ref);
      if (!contract.rotation) {
        const requestsBeforePlanning = [...fixture.requests];
        expect(fixture.registry).toBeDefined();
        expect(fixture.registry!.evaluateCapabilities(contract.slot, inventory)).toMatchObject({ available: false, reason: "service_unavailable" });
        expect(() => fixture.registry!.planRotation(contract.slot, inventory, { allowStop: true, attemptId: "contract-attempt" })).toThrow(expect.objectContaining({ code: "rotation_unsupported", reason: "service_unavailable" }));
        expect(fixture.requests).toEqual(requestsBeforePlanning);
        expect(fixture.unexpectedRequests).toEqual([]);
        return;
      }
      const rotation = requireCloudRotation(fixture.adapter);
      const registered = (fixture.registry ? fixture.registry.get(contract.service) : getCloudServiceRegistration(contract.service))?.rotation;
      expect(registered).toBeDefined();
      const capability = rotation.capabilities(contract.slot, inventory);
      expect(capability).toMatchObject({ available: true, permission: "unverified" });
      expect(fixture.registry ? fixture.registry.evaluateCapabilities(contract.slot, inventory) : evaluateCapabilities(contract.slot, inventory)).toEqual(capability);
      expect(registered!.capabilities(contract.slot, inventory)).toEqual(capability);
      const options = { allowStop: true, attemptId: "contract-attempt" };
      const requestsBeforePlanning = [...fixture.requests];
      const plan = fixture.registry ? fixture.registry.planRotation(contract.slot, inventory, options) : planCloudRotation(contract.slot, inventory, options);
      expect(plan.map(step => step.action)).toEqual(contract.rotation.actions);
      expect(registered!.planRotation(contract.slot, inventory, options)).toEqual(plan);
      for (const step of plan) {
        expect(step.arguments).toMatchObject({ slot: contract.slot, before: inventory, phase: "rotation", attemptId: "contract-attempt" });
      }
      expect(fixture.requests).toEqual(requestsBeforePlanning);
      expect(fixture.unexpectedRequests).toEqual([]);
    });

    if (contract.rotation) {
      const rotationContract = contract.rotation;
      for (const scenario of rotationContract.observations) {
        it(`observes ${scenario.state} persisted work after reconnect without repeating a cloud write`, async () => {
          const fixture = contract.create();
          const inventory = await fixture.adapter.inspect(contract.inventory.ref);
          const options = { allowStop: true, attemptId: "contract-attempt" };
          const plan = fixture.registry ? fixture.registry.planRotation(contract.slot, inventory, options) : planCloudRotation(contract.slot, inventory, options);
          expect(fixture.prepareObservation).toBeTypeOf("function");
          expect(fixture.reconnect).toBeTypeOf("function");
          // Recovery starts from persisted JSON and a new adapter, with no process-local mutation history.
          const step = JSON.parse(JSON.stringify(fixture.prepareObservation!(plan, scenario.state))) as CloudStep;
          expect(step.arguments.previousExecution).toBe(true);
          const persisted = structuredClone(step);
          const recovered = requireCloudRotation(fixture.reconnect!());
          if (rotationContract.detailedObservation) {
            expect(recovered.observeDetails).toBeTypeOf("function");
            expect(await recovered.observeDetails!(step)).toMatchObject(scenario.expected);
          } else expect(recovered.observeDetails).toBeUndefined();
          expect(await recovered.observe(step)).toBe(scenario.expected.status);
          if (scenario.expected.status === "applied") {
            expect(await recovered.execute(step)).toMatchObject(scenario.expected);
          } else {
            await expect(recovered.execute(step)).rejects.toMatchObject({ code: "resource_ownership_ambiguous", retryable: false });
          }
          expect(step).toEqual(persisted);
          expect(fixture.unexpectedRequests).toEqual([]);
        });
      }
    }
  });
}

for (const contract of adapterContractCases) describeAdapterContract(contract);
