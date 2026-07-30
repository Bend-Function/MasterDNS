import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Redis } from "ioredis";

type ZoneLockRedis = Pick<Redis, "set" | "eval">;

const REFRESH_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export type DnsZoneLockErrorCode = "timeout" | "unavailable" | "lost";

export class DnsZoneLockError extends Error {
  constructor(message: string, readonly code: DnsZoneLockErrorCode, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "DnsZoneLockError";
  }
}

export function isDnsZoneLockError(error: unknown): error is DnsZoneLockError {
  return error instanceof DnsZoneLockError;
}

export type DnsZoneLease = {
  readonly signal: AbortSignal;
  assertOwned(): void;
};

export type DnsZoneLockOptions = {
  leaseMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  refreshIntervalMs?: number;
  commandTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  onCleanupError?: (error: unknown) => void;
};

export function withDnsZoneLock<T>(
  redis: ZoneLockRedis,
  zoneId: string,
  action: (lease: DnsZoneLease) => Promise<T>,
  options: DnsZoneLockOptions = {},
): Promise<T> {
  return withRedisLease(redis, `masterdns:zone-lock:${zoneId}`, `DNS zone lock ${zoneId}`, action, options);
}

export async function withRedisLease<T>(
  redis: ZoneLockRedis,
  key: string,
  description: string,
  action: (lease: DnsZoneLease) => Promise<T>,
  options: DnsZoneLockOptions = {},
): Promise<T> {
  const leaseMs = positiveOption("leaseMs", options.leaseMs ?? 120_000);
  const waitTimeoutMs = positiveOption("waitTimeoutMs", options.waitTimeoutMs ?? 30_000);
  const pollIntervalMs = positiveOption("pollIntervalMs", options.pollIntervalMs ?? 100);
  const refreshIntervalMs = positiveOption("refreshIntervalMs", options.refreshIntervalMs ?? Math.max(1_000, Math.floor(leaseMs / 3)));
  const commandTimeoutMs = positiveOption("commandTimeoutMs", options.commandTimeoutMs ?? Math.min(5_000, Math.max(100, Math.floor(leaseMs / 6))));
  const cleanupTimeoutMs = positiveOption("cleanupTimeoutMs", options.cleanupTimeoutMs ?? Math.min(2_000, commandTimeoutMs));
  if (refreshIntervalMs + commandTimeoutMs >= leaseMs) {
    throw new Error("refreshIntervalMs plus commandTimeoutMs must be shorter than leaseMs");
  }
  const token = randomUUID();
  const deadline = Date.now() + waitTimeoutMs;

  await acquire(redis, key, token, description, leaseMs, deadline, pollIntervalMs, commandTimeoutMs, cleanupTimeoutMs, options.onCleanupError);

  const leaseController = new AbortController();
  const renewalController = new AbortController();
  let lostError: DnsZoneLockError | undefined;
  const markLost = (cause: unknown) => {
    if (lostError) return;
    lostError = new DnsZoneLockError(`Lost ${description}`, "lost", { cause });
    leaseController.abort(lostError);
  };
  const lease: DnsZoneLease = {
    signal: leaseController.signal,
    assertOwned() {
      if (lostError) throw lostError;
    },
  };

  const renewal = renew(redis, key, token, leaseMs, refreshIntervalMs, commandTimeoutMs, renewalController.signal, markLost);
  let value: T | undefined;
  let actionError: unknown;
  let actionFailed = false;
  try {
    value = await action(lease);
    lease.assertOwned();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  } finally {
    renewalController.abort();
    await renewal;
  }

  try {
    const released = await commandWithin(
      redis.eval(RELEASE_SCRIPT, 1, key, token),
      cleanupTimeoutMs,
      () => new Error(`Timed out releasing ${description}`),
    );
    if (released !== 1 && !lostError) markLost(new Error("Lock token no longer owns the key"));
  } catch (error) {
    reportCleanupError(options.onCleanupError, error);
  }

  if (actionFailed) throw actionError;
  if (lostError) throw lostError;
  return value as T;
}

async function acquire(
  redis: ZoneLockRedis,
  key: string,
  token: string,
  description: string,
  leaseMs: number,
  deadline: number,
  pollIntervalMs: number,
  commandTimeoutMs: number,
  cleanupTimeoutMs: number,
  onCleanupError: ((error: unknown) => void) | undefined,
) {
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new DnsZoneLockError(`Timed out waiting for ${description}`, "timeout");
    const command = redis.set(key, token, "PX", leaseMs, "NX");
    let acquired: string | null;
    try {
      acquired = await commandWithin(
        command,
        Math.min(remainingMs, commandTimeoutMs),
        () => new DnsZoneLockError(`Timed out acquiring ${description}`, "timeout"),
      );
    } catch (error) {
      if (error instanceof DnsZoneLockError) {
        void command.then((lateResult) => {
          if (lateResult === "OK") void releaseLateAcquisition(redis, key, token, description, cleanupTimeoutMs, onCleanupError);
        }).catch(() => undefined);
        throw error;
      }
      throw new DnsZoneLockError(`${description} is unavailable`, "unavailable", { cause: error });
    }
    if (acquired === "OK") return;
    const delayMs = Math.min(pollIntervalMs, deadline - Date.now());
    if (delayMs <= 0) throw new DnsZoneLockError(`Timed out waiting for ${description}`, "timeout");
    await delay(delayMs);
  }
}

async function renew(
  redis: ZoneLockRedis,
  key: string,
  token: string,
  leaseMs: number,
  refreshIntervalMs: number,
  commandTimeoutMs: number,
  signal: AbortSignal,
  markLost: (cause: unknown) => void,
) {
  while (!signal.aborted) {
    try {
      await delay(refreshIntervalMs, undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      markLost(error);
      return;
    }
    if (signal.aborted) return;
    try {
      const refreshed = await commandWithin(
        redis.eval(REFRESH_SCRIPT, 1, key, token, leaseMs),
        commandTimeoutMs,
        () => new Error("Timed out renewing the lock lease"),
      );
      if (refreshed !== 1) {
        markLost(new Error("Lock token no longer owns the key"));
        return;
      }
    } catch (error) {
      markLost(error);
      return;
    }
  }
}

async function releaseLateAcquisition(
  redis: ZoneLockRedis,
  key: string,
  token: string,
  description: string,
  cleanupTimeoutMs: number,
  onCleanupError: ((error: unknown) => void) | undefined,
) {
  try {
    await commandWithin(redis.eval(RELEASE_SCRIPT, 1, key, token), cleanupTimeoutMs, () => new Error(`Timed out releasing a late ${description} acquisition`));
  } catch (error) {
    reportCleanupError(onCleanupError, error);
  }
}

function commandWithin<T>(command: Promise<T>, timeoutMs: number, timeoutError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), timeoutMs);
    command.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function reportCleanupError(handler: ((error: unknown) => void) | undefined, error: unknown) {
  try {
    handler?.(error);
  } catch {
    // Cleanup reporting must not change the protected action's outcome.
  }
}

function positiveOption(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero`);
  return value;
}
