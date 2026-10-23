import { afterEach, expect, it, vi } from "vitest";
import { RotationProcessor } from "./rotation.processor.js";
vi.mock("../env.js", () => ({ env: { MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } }));
afterEach(() => vi.useRealTimers());

it.each(["identity", "inspect", "execute", "observe"])("releases a queue execution when %s never responds", async stage => {
  vi.useFakeTimers();
  let resolveWrite!: (receipt: object) => void;
  const pending = new Promise<object>(resolve => { resolveWrite = resolve; });
  const lease = { physicalKey: "physical", holder: "worker", revision: 1 };
  const plan = { id: "step", arguments: {} };
  const store = {
    claim: vi.fn().mockResolvedValue(lease),
    read: vi.fn().mockResolvedValue({ incident: { phase: "cloud" }, c: { policy: { cloudWaitSeconds: 10 }, account: { id: "account" }, instance: { service: "ec2" } },
      action: stage === "observe" ? { kind: "observe", stepId: "step" } : { kind: "execute", operation: stage === "execute" ? "cloud_step" : "prepare_attempt", stepId: "step" }, steps: [{ id: "step", plan }] }),
    dispatch: vi.fn().mockResolvedValue(plan), prepare: vi.fn(), reject: vi.fn(), pause: vi.fn(), release: vi.fn(), saveReceipt: vi.fn(),
  };
  const adapter = { capabilities: vi.fn(), observe: vi.fn(), inspect: vi.fn().mockImplementation(() => pending), execute: vi.fn().mockImplementation(() => pending), observeDetails: vi.fn().mockImplementation(() => pending) };
  const runtime = { adapter: vi.fn().mockImplementation(() => stage === "identity" ? pending : Promise.resolve(adapter)) };
  const processor = new RotationProcessor(store as never, runtime as never, {} as never);
  const running = processor.run("incident");
  await vi.advanceTimersByTimeAsync(10_001);
  await running;
  expect(store.release).toHaveBeenCalledWith(lease);
  if (stage === "execute") expect(store.reject).toHaveBeenCalledWith("incident", "step", "rotation_call_timeout", false, undefined, lease.revision);
  else expect(store.pause).toHaveBeenCalledWith("incident", "rotation_call_timeout", undefined);
  if (stage === "execute") {
    resolveWrite({ allocationId: "allocation" });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.saveReceipt).toHaveBeenCalledWith("incident", "step", { allocationId: "allocation" }, false, lease.revision);
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  }
});
