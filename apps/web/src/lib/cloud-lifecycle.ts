import { cloudTrafficStopPolicySchema, type CloudLifecycleAction, type CloudLifecycleOperation, type CloudTrafficStopPolicyInput } from "@masterdns/contracts/cloud-lifecycle";
import type { CloudService } from "@masterdns/contracts/cloud";
import type { CloudAuthorization } from "./cloud-types";

const BYTES_PER_GIGABYTE = 1_000_000_000n;
const MAX_SAFE_BYTES = BigInt(Number.MAX_SAFE_INTEGER);

export type LifecyclePolicyDraft = {
  revision: number;
  enabled: boolean;
  thresholdGigabytes: string;
  direction: "total" | "outgoing";
  checkIntervalMinutes: string;
};

export function parseLifecyclePolicyInput(draft: LifecyclePolicyDraft): CloudTrafficStopPolicyInput {
  const thresholdBytes = parseGigabytes(draft.thresholdGigabytes);
  if (draft.enabled && thresholdBytes === null) throw new Error("启用策略时必须填写大于 0 的 GB 阈值");
  if (!/^\d+$/.test(draft.checkIntervalMinutes)) throw new Error("检查间隔必须是整数分钟");
  const checkIntervalMinutes = Number(draft.checkIntervalMinutes);
  if (!Number.isSafeInteger(checkIntervalMinutes) || checkIntervalMinutes < 1 || checkIntervalMinutes > 1_440) {
    throw new Error("检查间隔必须在 1 到 1440 分钟之间");
  }
  return cloudTrafficStopPolicySchema.parse({
    revision: draft.revision,
    enabled: draft.enabled,
    thresholdBytes,
    direction: draft.direction,
    checkIntervalSeconds: checkIntervalMinutes * 60,
  });
}

function parseGigabytes(raw: string): number | null {
  const value = raw.trim();
  if (value === "") return null;
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error("流量阈值必须是正数 GB");
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > 9 && /[1-9]/.test(fraction.slice(9))) throw new Error("GB 阈值最多精确到 1 字节");
  const bytes = BigInt(whole) * BYTES_PER_GIGABYTE + BigInt((fraction.slice(0, 9) + "000000000").slice(0, 9));
  if (bytes <= 0n) throw new Error("流量阈值必须是正数 GB");
  if (bytes > MAX_SAFE_BYTES) throw new Error("流量阈值超出安全范围");
  return Number(bytes);
}

export function lifecyclePolicyDraft(policy: { thresholdBytes: number | null; checkIntervalSeconds: number }) {
  return {
    thresholdGigabytes: policy.thresholdBytes === null ? "" : decimalGigabytes(policy.thresholdBytes),
    checkIntervalMinutes: String(policy.checkIntervalSeconds / 60),
  };
}

function decimalGigabytes(bytes: number): string {
  const whole = Math.floor(bytes / 1_000_000_000);
  const fraction = String(bytes % 1_000_000_000).padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function lifecycleActionDisabledReason(
  action: CloudLifecycleAction,
  authorization: Pick<CloudAuthorization, "managed" | "allowStopStart" | "allowDelete"> | null,
  context: { accountEnabled: boolean; inScope: boolean; present: boolean },
): string | null {
  if (!context.accountEnabled) return "云账号已停用";
  if (!context.inScope) return "实例已不在当前账号区域范围内";
  if (!context.present) return "云端实例已不存在";
  if (!authorization?.managed) return "请先保存 MasterDNS 管理授权";
  if (action === "delete" && !authorization.allowDelete) return "请先保存云实例删除授权";
  if (action !== "delete" && !authorization.allowStopStart) return "请先保存实例启动和停止授权";
  return null;
}

export function lifecycleStateDisabledReason(action: CloudLifecycleAction, service: CloudService, state: string | null): string | null {
  if (action === "start" && (state === "running" || state === "starting")) return "实例已经在运行或启动中";
  if (action === "stop") {
    if (state === "stopping" || (service === "azure_vm" && state === "deallocating")) return "实例已经停止或停止中";
    if (service === "azure_vm" ? state === "deallocated" : state === "stopped") return "实例已经停止或停止中";
  }
  if ((state === "deleted" || state === "deleting") && action !== "delete") return "实例已经删除或删除中";
  if (action === "delete" && (state === "deleted" || state === "deleting")) return "实例已经删除或删除中";
  return null;
}

export function validDeleteConfirmation(value: string, externalId: string): boolean {
  return value === externalId;
}

export function policyMutationDisabledReason(
  currentEnabled: boolean,
  draftEnabled: boolean,
  context: { accountEnabled: boolean; inScope: boolean; present: boolean; managed: boolean; allowStopStart: boolean },
): string | null {
  if (currentEnabled && !draftEnabled) return null;
  if (!context.accountEnabled) return "云账号已停用，只能关闭现有策略";
  if (!context.inScope) return "实例已不在当前账号区域范围内，只能关闭现有策略";
  if (!context.present) return "云端实例已不存在，只能关闭现有策略";
  if (!context.managed) return "请先保存 MasterDNS 管理授权";
  if (!context.allowStopStart) return "请先保存实例启动和停止授权";
  return null;
}

export function shouldPollLifecycle(operations: Array<Pick<CloudLifecycleOperation, "status">>): boolean {
  return operations.some((operation) => operation.status === "queued" || operation.status === "in_flight");
}

export function createLifecyclePollLoop<T>(
  request: () => Promise<void>,
  intervalMs: number,
  scheduler: { set: (callback: () => void, delayMs: number) => T; clear: (handle: T) => void },
) {
  let stopped = true;
  let handle: T | null = null;
  const schedule = () => {
    if (stopped) return;
    handle = scheduler.set(() => {
      handle = null;
      void tick();
    }, intervalMs);
  };
  const tick = async () => {
    try { await request(); }
    catch { /* Loading reports the request error; pending polling still retries. */ }
    finally { schedule(); }
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      if (handle !== null) scheduler.clear(handle);
      handle = null;
    },
  };
}

export type LifecycleRequestToken = { instanceId: string; generation: number };

export function createLifecycleRequestGuard() {
  let generation = 0;
  let current: LifecycleRequestToken | null = null;
  return {
    begin(instanceId: string): LifecycleRequestToken {
      current = { instanceId, generation: ++generation };
      return current;
    },
    isCurrent(token: LifecycleRequestToken): boolean {
      return token === current && token.generation === generation;
    },
    invalidate(): void {
      generation += 1;
      current = null;
    },
  };
}
