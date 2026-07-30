import type { HealthCheckConfig } from "@masterdns/contracts";
import type { HealthChecker } from "./checker.js";
import { HttpHealthChecker } from "./http-checker.js";
import { TcpHealthChecker } from "./tcp-checker.js";

export class CheckerRegistry {
  private readonly checkers = new Map<string, HealthChecker<never>>();

  constructor(checkers: HealthChecker<never>[] = [new HttpHealthChecker() as HealthChecker<never>, new TcpHealthChecker() as HealthChecker<never>]) {
    for (const checker of checkers) this.checkers.set(checker.type, checker);
  }

  get<T extends HealthCheckConfig>(type: T["type"]): HealthChecker<T> {
    const checker = this.checkers.get(type);
    if (!checker) throw new Error(`Unknown health checker: ${type}`);
    return checker as HealthChecker<T>;
  }
}
