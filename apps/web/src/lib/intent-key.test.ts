import { describe, expect, it, vi } from "vitest";
import { createIntentKey } from "./intent-key";

describe("createIntentKey", () => {
  it("reuses one key while the same user intent is retried", () => {
    const factory = vi.fn(() => "intent-1");
    const intentKey = createIntentKey(factory);

    expect(intentKey.current()).toBe("intent-1");
    expect(intentKey.current()).toBe("intent-1");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("rotates only after the intent is reset", () => {
    const keys = ["intent-1", "intent-2"];
    const intentKey = createIntentKey(() => keys.shift() ?? "unexpected");

    expect(intentKey.current()).toBe("intent-1");
    intentKey.reset();
    expect(intentKey.current()).toBe("intent-2");
  });

  it("does not allocate a key until a mutation is submitted", () => {
    const factory = vi.fn(() => "intent-1");
    const intentKey = createIntentKey(factory);

    intentKey.reset();
    expect(factory).not.toHaveBeenCalled();
  });
});
