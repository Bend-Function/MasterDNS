import type { CheckResult, CheckTarget, HttpCheckConfig } from "@masterdns/contracts";
import { httpCheckConfigSchema } from "@masterdns/contracts";
import { Agent, request } from "undici";
import type { HealthChecker } from "./checker.js";
import { elapsedMs, errorResult } from "./checker.js";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class HttpHealthChecker implements HealthChecker<HttpCheckConfig> {
  readonly type = "http";

  validate(config: unknown): HttpCheckConfig {
    return httpCheckConfigSchema.parse(config);
  }

  async check(target: CheckTarget, configInput: HttpCheckConfig, externalSignal?: AbortSignal): Promise<CheckResult> {
    const config = this.validate(configInput);
    const startedAt = performance.now();
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
    const hostname = target.hostname ?? target.address;
    const dispatcher = config.protocol === "https"
      ? new Agent({ connect: { servername: hostname, rejectUnauthorized: config.verifyTls } })
      : new Agent();

    try {
      let path = config.path;
      let response: Awaited<ReturnType<typeof request>> | undefined;
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        response = await request(buildTargetUrl(config.protocol, target.address, target.port, path), {
          method: config.method,
          headers: { ...config.headers, host: hostname },
          dispatcher,
          signal,
          headersTimeout: config.timeoutMs,
          bodyTimeout: config.timeoutMs,
        });

        if (!config.followRedirects || response.statusCode < 300 || response.statusCode >= 400) break;
        const location = response.headers.location;
        await response.body.dump();
        if (!location) break;
        if (redirect === MAX_REDIRECTS) throw new Error("Health check exceeded redirect limit");
        path = redirectPath(location, hostname);
      }

      if (!response) throw new Error("HTTP checker did not receive a response");
      const body = config.method === "HEAD" ? "" : await readBodyLimited(response.body);
      const accepted = config.expectedStatuses
        ? config.expectedStatuses.includes(response.statusCode)
        : response.statusCode >= config.expectedStatusMin && response.statusCode <= config.expectedStatusMax;
      if (!accepted) {
        return failedHttpResult(startedAt, response.statusCode, "unexpected_status", `Unexpected HTTP status ${response.statusCode}`);
      }
      if (config.bodyContains !== undefined && !body.includes(config.bodyContains)) {
        return failedHttpResult(startedAt, response.statusCode, "body_mismatch", "Response body does not contain expected text");
      }
      if (config.bodyPattern !== undefined && !new RegExp(config.bodyPattern).test(body)) {
        return failedHttpResult(startedAt, response.statusCode, "body_mismatch", "Response body does not match expected pattern");
      }
      return { success: true, latencyMs: elapsedMs(startedAt), checkedAt: new Date(), statusCode: response.statusCode };
    } catch (error) {
      return errorResult(startedAt, error);
    } finally {
      await dispatcher.close();
    }
  }
}

function buildTargetUrl(protocol: "http" | "https", address: string, port: number, path: string): string {
  const formattedAddress = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return `${protocol}://${formattedAddress}:${port}${path}`;
}

function redirectPath(location: string | string[], hostname: string): string {
  const value = Array.isArray(location) ? location[0] : location;
  if (!value) return "/";
  if (value.startsWith("/")) return value;
  const parsed = new URL(value);
  if (parsed.hostname !== hostname) throw new Error("Health check redirect changed hostname");
  return `${parsed.pathname}${parsed.search}`;
}

function failedHttpResult(startedAt: number, statusCode: number, errorCode: string, errorDetail: string): CheckResult {
  return { success: false, latencyMs: elapsedMs(startedAt), checkedAt: new Date(), statusCode, errorCode, errorDetail };
}

async function readBodyLimited(body: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error("Health check response exceeded 1 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
