import { describe, expect, it } from "vitest";
import { actualEndpointFamilies, reconcileEndpointFamily } from "./health-target";

describe("ordinary endpoint address families", () => {
  const endpoint = { addresses: [
    { family: "4" as const, state: "previous" },
    { family: "6" as const, state: "current" },
    { family: "6" as const, state: "candidate" },
  ] };

  it("offers only families with a current actual address", () => {
    expect(actualEndpointFamilies(endpoint)).toEqual(["6"]);
  });

  it("revalidates an old family when the endpoint changes", () => {
    expect(reconcileEndpointFamily("4", endpoint)).toBe("6");
    expect(reconcileEndpointFamily("4", { addresses: [] })).toBeNull();
  });
});
