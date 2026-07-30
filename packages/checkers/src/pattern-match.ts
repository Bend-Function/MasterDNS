import { Worker } from "node:worker_threads";

const DEFAULT_PATTERN_TIMEOUT_MS = 100;

export async function matchesPatternSafely(pattern: string, input: string, timeoutMs = DEFAULT_PATTERN_TIMEOUT_MS): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      try {
        parentPort.postMessage({ result: new RegExp(workerData.pattern).test(workerData.input) });
      } catch (error) {
        parentPort.postMessage({ error: error instanceof Error ? error.message : "invalid pattern" });
      }
    `, { eval: true, workerData: { pattern, input } });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      action();
    };
    const timer = setTimeout(() => finish(() => reject(Object.assign(new Error("Response pattern exceeded execution limit"), {
      code: "pattern_timeout",
    }))), timeoutMs);
    worker.once("message", (message: { result?: boolean; error?: string }) => finish(() => {
      if (message.error) reject(Object.assign(new Error(message.error), { code: "invalid_pattern" }));
      else resolve(Boolean(message.result));
    }));
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish(() => reject(Object.assign(new Error(`Pattern worker exited with code ${code}`), {
        code: "pattern_failed",
      })));
    });
  });
}
