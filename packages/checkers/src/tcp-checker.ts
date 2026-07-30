import { createConnection } from "node:net";
import type { CheckResult, CheckTarget, TcpCheckConfig } from "@masterdns/contracts";
import { tcpCheckConfigSchema } from "@masterdns/contracts";
import type { HealthChecker } from "./checker.js";
import { elapsedMs, errorResult } from "./checker.js";
import { assertAllowedNetworkTarget, type NetworkTargetPolicy } from "./network-policy.js";

export class TcpHealthChecker implements HealthChecker<TcpCheckConfig> {
  readonly type = "tcp";

  constructor(private readonly networkPolicy: NetworkTargetPolicy = {}) {}

  validate(config: unknown): TcpCheckConfig {
    return tcpCheckConfigSchema.parse(config);
  }

  async check(target: CheckTarget, configInput: TcpCheckConfig, signal?: AbortSignal): Promise<CheckResult> {
    const config = this.validate(configInput);
    const startedAt = performance.now();
    try {
      assertAllowedNetworkTarget(target.address, this.networkPolicy);
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: target.address, port: target.port, family: target.family });
        const timer = setTimeout(() => socket.destroy(Object.assign(new Error("TCP health check timed out"), { code: "ETIMEDOUT" })), config.timeoutMs);
        const abort = () => socket.destroy(Object.assign(new Error("TCP health check aborted"), { code: "ABORT_ERR" }));
        signal?.addEventListener("abort", abort, { once: true });
        socket.once("connect", () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          socket.end();
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(error);
        });
      });
      return { success: true, latencyMs: elapsedMs(startedAt), checkedAt: new Date() };
    } catch (error) {
      return errorResult(startedAt, error);
    }
  }
}
