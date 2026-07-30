import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const RUNTIME_TOKEN_GRACE_MS = 10 * 60 * 1000;

type RuntimeTokenState = {
  runtimeTokenHash: string | null;
  previousRuntimeTokenHash: string | null;
  previousRuntimeTokenExpiresAt: Date | null;
};

type HeartbeatAddresses = { ipv4?: string | null | undefined; ipv6?: string | null | undefined };

export type DdnsAddressUpdate = { family: "4" | "6"; address: string | null };

export function runtimeTokenMatches(state: RuntimeTokenState, tokenHash: string, now = new Date()): boolean {
  if (state.runtimeTokenHash === tokenHash) return true;
  return state.previousRuntimeTokenHash === tokenHash
    && Boolean(state.previousRuntimeTokenExpiresAt && state.previousRuntimeTokenExpiresAt > now);
}

export function currentRuntimeTokenMatches(state: Pick<RuntimeTokenState, "runtimeTokenHash">, tokenHash: string): boolean {
  return state.runtimeTokenHash === tokenHash;
}

export function rotateRuntimeToken(currentTokenHash: string | null, nextTokenHash: string, now: Date) {
  return {
    runtimeTokenHash: nextTokenHash,
    previousRuntimeTokenHash: currentTokenHash,
    previousRuntimeTokenExpiresAt: currentTokenHash
      ? new Date(now.getTime() + RUNTIME_TOKEN_GRACE_MS)
      : null,
  };
}

export function resolveDdnsAddressUpdates(input: HeartbeatAddresses, inferredAddress?: string): DdnsAddressUpdate[] {
  const updates: DdnsAddressUpdate[] = [];
  if (Object.prototype.hasOwnProperty.call(input, "ipv4")) updates.push({ family: "4", address: input.ipv4 ?? null });
  if (Object.prototype.hasOwnProperty.call(input, "ipv6")) updates.push({ family: "6", address: input.ipv6 ?? null });

  if (inferredAddress) {
    const family = inferredAddress.includes(":") ? "6" : "4";
    const explicit = updates.find((item) => item.family === family);
    if (explicit?.address === null) explicit.address = inferredAddress;
    else if (!explicit) updates.push({ family, address: inferredAddress });
  }
  return updates;
}

export function buildDdnsInstallCommand(value: string) {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error("PUBLIC_API_URL 不能包含空白或控制字符");
  }
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || value.includes("?") || value.includes("#")) {
    throw new Error("PUBLIC_API_URL 不能包含账号、密码、查询参数或片段");
  }

  const apiUrl = parsed.toString().replace(/\/+$/, "");
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("DDNS Agent 默认要求 HTTPS；HTTP 仅允许显式使用 loopback 地址");
  }

  const allowInsecureLoopback = parsed.protocol === "http:";
  const protocol = allowInsecureLoopback ? "=http" : "=https";
  const insecureFlag = allowInsecureLoopback ? " --allow-insecure-loopback" : "";
  const proxyFlag = allowInsecureLoopback ? " --noproxy '*'" : "";
  return {
    apiUrl,
    allowInsecureLoopback,
    command: `curl -q -fsS${proxyFlag} --proto ${shellQuote(protocol)} --proto-redir ${shellQuote(protocol)} ${shellQuote(`${apiUrl}/api/v1/ddns/install.sh`)} | sudo sh -s -- install --url ${shellQuote(apiUrl)}${insecureFlag}`,
  };
}

export function resolveAgentScriptPath(name: "install.sh" | "masterdns-ddns"): string {
  const agentDirectory = fileURLToPath(new URL("../../../../../agent/", import.meta.url));
  return resolve(agentDirectory, name);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
