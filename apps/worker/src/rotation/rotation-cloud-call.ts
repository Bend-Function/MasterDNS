import { withCloudCallSignal } from "@masterdns/cloud-providers";

export class RotationCallTimeout extends Error {}
export async function boundedCloudCall<T>(operation: () => Promise<T>, timeoutMs: number, lateResult?: (value: T) => Promise<unknown>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const controller = new AbortController();
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { timedOut = true; const error = new RotationCallTimeout("rotation_call_timeout"); controller.abort(error); reject(error); }, timeoutMs);
  });
  // Keep a late mutation receipt attached to its durable intent. No continuation
  // can prepare or dispatch another step after the caller has timed out.
  const observed = Promise.resolve().then(() => withCloudCallSignal(controller.signal, operation)).then(async value => {
    if (timedOut && lateResult) await lateResult(value);
    return value;
  });
  try { return await Promise.race([observed, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}
