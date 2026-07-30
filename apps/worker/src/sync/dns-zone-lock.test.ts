import { describe, expect, it, vi } from "vitest";
import { withDnsZoneLock, withRedisLease } from "./dns-zone-lock.js";

describe("DNS zone lock", () => {
  it("supports the exact operation lock key through the shared lease implementation", async () => {
    const redis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn().mockResolvedValue(1),
    };

    await expect(withRedisLease(
      redis as never,
      "masterdns:operation-lock:operation-1",
      "operation lock operation-1",
      async (lease) => {
        lease.assertOwned();
        return "done";
      },
    )).resolves.toBe("done");

    expect(redis.set).toHaveBeenCalledWith("masterdns:operation-lock:operation-1", expect.any(String), "PX", 120_000, "NX");
    expect(redis.eval).toHaveBeenLastCalledWith(expect.stringContaining("del"), 1, "masterdns:operation-lock:operation-1", expect.any(String));
  });

  it("uses the shared zone key and releases it after success", async () => {
    const redis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn().mockResolvedValue(1),
    };

    await expect(withDnsZoneLock(redis as never, "zone-1", async (lease) => {
      lease.assertOwned();
      return "done";
    })).resolves.toBe("done");

    expect(redis.set).toHaveBeenCalledWith("masterdns:zone-lock:zone-1", expect.any(String), "PX", 120_000, "NX");
    expect(redis.eval).toHaveBeenLastCalledWith(expect.stringContaining("del"), 1, "masterdns:zone-lock:zone-1", expect.any(String));
  });

  it("preserves the action error when releasing the lock also fails", async () => {
    const cleanup = vi.fn();
    const redis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn().mockRejectedValue(new Error("redis unavailable")),
    };
    const actionError = new Error("provider failed");

    await expect(withDnsZoneLock(redis as never, "zone-2", async () => {
      throw actionError;
    }, { onCleanupError: cleanup })).rejects.toBe(actionError);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("keeps a successful result when only the release command fails", async () => {
    const cleanup = vi.fn();
    const redis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn().mockRejectedValue(new Error("redis unavailable")),
    };

    await expect(withDnsZoneLock(redis as never, "zone-3", async () => "done", { onCleanupError: cleanup })).resolves.toBe("done");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("detects lease ownership loss and aborts the lease signal", async () => {
    const redis = {
      set: vi.fn().mockResolvedValue("OK"),
      eval: vi.fn(async (script: string) => script.includes("pexpire") ? 0 : 0),
    };
    let aborted = false;

    await expect(withDnsZoneLock(redis as never, "zone-4", async (lease) => {
      await new Promise<void>((resolve) => lease.signal.addEventListener("abort", () => {
        aborted = true;
        resolve();
      }, { once: true }));
      lease.assertOwned();
      return "unreachable";
    }, {
      leaseMs: 50,
      refreshIntervalMs: 2,
      commandTimeoutMs: 10,
    })).rejects.toMatchObject({ code: "lost" });
    expect(aborted).toBe(true);
  });

  it("bounds a Redis command that never settles", async () => {
    const redis = {
      set: vi.fn(() => new Promise<string | null>(() => undefined)),
      eval: vi.fn(),
    };
    const action = vi.fn();

    await expect(withDnsZoneLock(redis as never, "zone-5", action, {
      waitTimeoutMs: 10,
      commandTimeoutMs: 50,
    })).rejects.toMatchObject({ code: "timeout" });
    expect(action).not.toHaveBeenCalled();
  });

  it("releases an acquisition that succeeds after its caller timed out", async () => {
    let resolveSet: ((value: string | null) => void) | undefined;
    const redis = {
      set: vi.fn(() => new Promise<string | null>((resolve) => { resolveSet = resolve; })),
      eval: vi.fn().mockResolvedValue(1),
    };

    const result = withDnsZoneLock(redis as never, "zone-late", async () => "unreachable", {
      waitTimeoutMs: 5,
      commandTimeoutMs: 20,
      cleanupTimeoutMs: 5,
    });
    await expect(result).rejects.toMatchObject({ code: "timeout" });
    resolveSet?.("OK");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining("del"), 1, "masterdns:zone-lock:zone-late", expect.any(String));
  });

  it("times out on ordinary contention without running the action", async () => {
    const redis = {
      set: vi.fn().mockResolvedValue(null),
      eval: vi.fn(),
    };
    const action = vi.fn();

    await expect(withDnsZoneLock(redis as never, "zone-6", action, {
      waitTimeoutMs: 5,
      pollIntervalMs: 1,
    })).rejects.toMatchObject({ code: "timeout" });
    expect(action).not.toHaveBeenCalled();
  });

  it("rejects a renewal schedule that cannot complete before lease expiry", async () => {
    const redis = { set: vi.fn(), eval: vi.fn() };
    await expect(withDnsZoneLock(redis as never, "zone-invalid", async () => undefined, {
      leaseMs: 100,
      refreshIntervalMs: 80,
      commandTimeoutMs: 20,
    })).rejects.toThrow(/shorter than leaseMs/);
    expect(redis.set).not.toHaveBeenCalled();
  });
});
