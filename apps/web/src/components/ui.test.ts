import { describe, expect, it } from "vitest";
import { getFocusWrapIndex } from "./ui";

describe("getFocusWrapIndex", () => {
  it("wraps forward from the last item and backward from the first", () => {
    expect(getFocusWrapIndex(3, 2, false)).toBe(0);
    expect(getFocusWrapIndex(3, 0, true)).toBe(2);
  });

  it("enters at the appropriate edge when focus starts outside", () => {
    expect(getFocusWrapIndex(3, -1, false)).toBe(0);
    expect(getFocusWrapIndex(3, -1, true)).toBe(2);
  });

  it("does not move focus away from an interior item", () => {
    expect(getFocusWrapIndex(3, 1, false)).toBeNull();
    expect(getFocusWrapIndex(3, 1, true)).toBeNull();
  });

  it("returns no target for an empty collection", () => {
    expect(getFocusWrapIndex(0, -1, false)).toBeNull();
  });
});
