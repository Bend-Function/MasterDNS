import type { HealthCheckConfig } from "@masterdns/contracts";
import type { HealthChecker } from "./checker.js";
import { HttpHealthChecker } from "./http-checker.js";
import type { NetworkTargetPolicy } from "./network-policy.js";
import { TcpHealthChecker } from "./tcp-checker.js";

export class CheckerRegistry {
  private readonly checkers = new Map<string, HealthChecker<never>>();

  constructor(
    checkers?: HealthChecker<never>[],
    networkPolicy: NetworkTargetPolicy = {},
  ) {
    const configured = checkers ?? [
      new HttpHealthChecker(networkPolicy) as unknown as HealthChecker<never>,
      new TcpHealthChecker(networkPolicy) as unknown as HealthChecker<never>,
    ];
    for (const checker of configured) this.checkers.set(checker.type, checker);
  }

  get<T extends HealthCheckConfig>(type: T["type"]): HealthChecker<T> {
    const checker = this.checkers.get(type);
    if (!checker) throw new Error(`Unknown health checker: ${type}`);
    return checker as HealthChecker<T>;
  }
}
