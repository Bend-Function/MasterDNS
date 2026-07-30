import type { CheckResult, CheckTarget } from "@masterdns/contracts";

export interface HealthChecker<TConfig> {
  readonly type: string;
  validate(config: unknown): TConfig;
  check(target: CheckTarget, config: TConfig, signal?: AbortSignal): Promise<CheckResult>;
}

export function errorResult(startedAt: number, error: unknown): CheckResult {
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof candidate.code === "string"
    ? candidate.code.toLowerCase()
    : typeof candidate.name === "string"
      ? candidate.name.toLowerCase()
      : "check_failed";
  const detail = typeof candidate.message === "string" ? candidate.message.slice(0, 240) : "Health check failed";
  return {
    success: false,
    latencyMs: elapsedMs(startedAt),
    checkedAt: new Date(),
    errorCode: code,
    errorDetail: detail,
  };
}

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
