import { AsyncLocalStorage } from "node:async_hooks";

const cloudCall = new AsyncLocalStorage<AbortSignal>();

/** Scope cancellation to this call, including SDK preflight continuations. */
export function withCloudCallSignal<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  return cloudCall.run(signal, action);
}

/** Every transport checks immediately before dispatch, even after earlier awaits. */
export function cloudCallSignal(requestTimeoutMs: number): AbortSignal;
export function cloudCallSignal(): AbortSignal | undefined;
export function cloudCallSignal(requestTimeoutMs?: number): AbortSignal | undefined {
  const signal = cloudCall.getStore();
  signal?.throwIfAborted();
  if (requestTimeoutMs === undefined) return signal;
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
