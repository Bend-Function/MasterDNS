import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RotationTemporaryInstances } from "./rotation-temporary-instances";

describe("rotation temporary instances", () => {
  const helper = { id: "123456", label: "masterdns-swap-attempt-1", region: "ap-south", attemptId: "attempt-1", originalAddress: "192.0.2.1", candidateAddress: "192.0.2.2", cleanupStatus: "retained" };
  it("identifies retained helpers and explains ongoing charges", () => {
    const html = renderToStaticMarkup(createElement(RotationTemporaryInstances, { instances: [helper] }));
    for (const value of ["123456", "masterdns-swap-attempt-1", "ap-south", "attempt-1", "192.0.2.1", "192.0.2.2", "持续计费"]) expect(html).toContain(value);
  });
  it("does not claim a deleted helper still incurs charges", () => {
    const html = renderToStaticMarkup(createElement(RotationTemporaryInstances, { instances: [{ ...helper, cleanupStatus: "released" }] }));
    expect(html).toContain("123456");
    expect(html).not.toContain("持续计费");
  });
  it("does not show a temporary-instance section for additional-IP rotations", () => {
    expect(renderToStaticMarkup(createElement(RotationTemporaryInstances, {}))).toBe("");
  });
});
