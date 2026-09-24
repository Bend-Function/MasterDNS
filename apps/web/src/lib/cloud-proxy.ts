export type CloudProxyStatus = {
  configured: boolean;
  endpoint: string | null;
};

export type CloudProxyCheckResult = {
  ok: boolean;
  ip: string | null;
  checkedAt: string;
  latencyMs: number;
  error: string | null;
};

export type CloudProxyProfile = {
  id: string;
  ownerUserId: string;
  name: string;
  endpoint: string;
  assignedAccountIds: string[];
  createdAt: string;
  updatedAt: string;
};

export function proxiesForOwner<T extends { ownerUserId: string }>(profiles: T[], ownerUserId: string): T[] {
  return profiles.filter(profile => profile.ownerUserId === ownerUserId);
}

export function parseProxyUrl(raw: string): { proxyUrl: string; sanitizedEndpoint: string } {
  const proxyUrl = raw.trim();
  let parsed: URL;
  try { parsed = new URL(proxyUrl); }
  catch { throw new Error("请输入完整的 socks5:// 或 socks5h:// 代理地址"); }
  if (parsed.protocol !== "socks5:" && parsed.protocol !== "socks5h:") throw new Error("仅支持 socks5:// 或 socks5h:// 代理地址");
  if (!parsed.hostname) throw new Error("代理地址必须包含主机名");
  if (!parsed.port) throw new Error("代理地址必须包含端口");
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) throw new Error("代理地址不能包含路径、查询参数或片段");
  return { proxyUrl, sanitizedEndpoint: `${parsed.protocol}//${parsed.hostname}:${parsed.port}` };
}

export function proxyErrorMessage(value: unknown, secretDraft: string, fallback = "代理请求失败"): string {
  const message = value instanceof Error ? value.message : fallback;
  return secretDraft ? message.split(secretDraft).join("[代理地址]") : message;
}
