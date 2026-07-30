import { EventEmitter } from "node:events";
import { HttpException, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { SseConcurrencyGuard } from "./sse-concurrency.guard.js";

function executionContext(raw: EventEmitter, currentUser: { id: string } | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ currentUser }),
      getResponse: () => ({ raw }),
    }),
  } as unknown as ExecutionContext;
}

describe("SSE concurrency guard", () => {
  it("acquires a per-user lease and releases it when the stream closes", async () => {
    const queues = {
      acquireConcurrencyLease: vi.fn().mockResolvedValue(true),
      renewConcurrencyLease: vi.fn().mockResolvedValue(true),
      releaseConcurrencyLease: vi.fn().mockResolvedValue(undefined),
    };
    const raw = new EventEmitter();
    const guard = new SseConcurrencyGuard(queues as never);

    await expect(guard.canActivate(executionContext(raw, { id: "user-1" }))).resolves.toBe(true);
    expect(queues.acquireConcurrencyLease).toHaveBeenCalledWith("masterdns:sse:user-1", expect.any(String), 5, 75_000);
    raw.emit("close");
    await Promise.resolve();
    expect(queues.releaseConcurrencyLease).toHaveBeenCalledWith("masterdns:sse:user-1", expect.any(String));
  });

  it("returns 429 when the user already owns the maximum connections", async () => {
    const queues = {
      acquireConcurrencyLease: vi.fn().mockResolvedValue(false),
      renewConcurrencyLease: vi.fn(),
      releaseConcurrencyLease: vi.fn(),
    };
    const guard = new SseConcurrencyGuard(queues as never);

    const error = await guard.canActivate(executionContext(new EventEmitter(), { id: "user-1" })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
  });
});
