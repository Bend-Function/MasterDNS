const RELEASE_BASE_URL = "https://github.com/Bend-Function/MasterDNS-Agent/releases/download";
const PINNED_VERSION = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

export type ProbeAgentConfigInput = {
  serverUrl: string;
  probeId: string;
  maxConcurrency: number;
};

export function createProbeAgentConfigJson(input: ProbeAgentConfigInput & { platform?: "linux" | "manual" }): string {
  const server = new URL(input.serverUrl);
  if (server.protocol !== "https:" || server.username || server.password) {
    throw new Error("Agent 配置需要不含用户名和密码的 HTTPS API 地址");
  }
  const manual = input.platform === "manual";
  return JSON.stringify({
    serverUrl: server.toString().replace(/\/$/u, ""),
    caFile: "",
    probeId: input.probeId,
    tokenFile: manual ? "./runtime-token" : "/etc/masterdns-agent/runtime-token",
    stateDir: manual ? "./state" : "/var/lib/masterdns-agent",
    maxConcurrency: Math.min(input.maxConcurrency, 64),
    allowIpv4: true,
    allowIpv6: true,
    allowedPrivateCidrs: [],
  }, null, 2);
}

export type ProbeInstallInstructions = {
  installToken: string;
  expiresAt: string;
  downloadUrl: string;
  installCommand: string;
  enrollCommand: string;
  startCommand: string;
};

export function createProbeInstallInstructions(input: { version: string; serverUrl: string; installToken: string; expiresAt: string }): ProbeInstallInstructions {
  if (!PINNED_VERSION.test(input.version)) throw new Error("A pinned Agent version is required");
  const server = new URL(input.serverUrl);
  if (server.protocol !== "https:") throw new Error("Agent enrollment requires an HTTPS server URL");
  const serverUrl = server.toString().replace(/\/$/u, "");
  const downloadUrl = `${RELEASE_BASE_URL}/${input.version}/install.sh`;
  return {
    installToken: input.installToken,
    expiresAt: input.expiresAt,
    downloadUrl,
    installCommand: `curl -fsSLo /tmp/masterdns-agent-install.sh ${shellQuote(downloadUrl)} && sudo sh /tmp/masterdns-agent-install.sh install --version ${shellQuote(input.version)} --server-url ${shellQuote(serverUrl)}`,
    enrollCommand: "sudo -u masterdns-agent /usr/local/bin/masterdns-agent enroll --config /etc/masterdns-agent/config.json",
    startCommand: "sudo systemctl start masterdns-agent",
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
