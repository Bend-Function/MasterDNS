import type { MonthlyTraffic } from "@masterdns/contracts";
import { CloudError } from "./errors.js";

export function monthPeriod(now: Date) {
  return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: now };
}

export function trafficNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new CloudError("temporary_cloud_error", true);
  return value;
}

/** Empty or missing samples must not be rendered as zero consumption. */
export function sumTraffic(values: unknown[]): number | null {
  const numbers = values.map(trafficNumber).filter((value): value is number => value !== null);
  return numbers.length ? trafficNumber(numbers.reduce((sum, value) => sum + value, 0)) : null;
}

export function monthlyTrafficResult(source: MonthlyTraffic["source"], now: Date, incomingBytes: number | null, outgoingBytes: number | null, allowance: MonthlyTraffic["allowance"] = null): MonthlyTraffic {
  const period = monthPeriod(now);
  return {
    month: period.start.toISOString().slice(0, 7), periodStart: period.start.toISOString(), periodEnd: period.end.toISOString(), fetchedAt: new Date().toISOString(),
    source, incomingBytes, outgoingBytes, totalBytes: incomingBytes === null || outgoingBytes === null ? null : trafficNumber(incomingBytes + outgoingBytes), allowance,
  };
}
