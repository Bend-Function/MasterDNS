import { NodeHttpHandler } from "@smithy/node-http-handler";
import nodeFetch from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";

const invalidProxy = () => new Error("Invalid SOCKS proxy URL");

export type ParsedCloudProxy = {
  href: string;
  hostname: string;
  port: number;
  protocol: "socks5:" | "socks5h:";
};

export function parseCloudProxyUrl(value: string): ParsedCloudProxy {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidProxy();
  }
  if ((url.protocol !== "socks5:" && url.protocol !== "socks5h:")
    || !url.hostname || url.pathname !== "" || url.search || url.hash
    || (!url.username && url.password)) throw invalidProxy();
  const port = url.port === "" ? 1080 : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw invalidProxy();
  try {
    if (decodeURIComponent(url.username).length > 255 || decodeURIComponent(url.password).length > 255) throw invalidProxy();
  } catch {
    throw invalidProxy();
  }
  return { href: url.href, hostname: url.hostname, port, protocol: url.protocol };
}

export function proxyEndpoint(proxyUrl: string): string {
  const parsed = parseCloudProxyUrl(proxyUrl);
  return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
}

export function createCloudFetch(proxyUrl?: string): typeof fetch {
  if (proxyUrl === undefined) return fetch;
  const parsed = parseCloudProxyUrl(proxyUrl);
  const agent = createSocksAgent(parsed);
  const proxiedFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    nodeFetch(input as never, (init === undefined ? { agent } : { ...init, agent }) as never);
  return proxiedFetch as unknown as typeof fetch;
}

export function createAwsRequestHandler(proxyUrl?: string): NodeHttpHandler | undefined {
  if (proxyUrl === undefined) return undefined;
  const parsed = parseCloudProxyUrl(proxyUrl);
  return new NodeHttpHandler({
    connectionTimeout: 3_000,
    requestTimeout: 10_000,
    throwOnRequestTimeout: true,
    httpsAgent: createSocksAgent(parsed),
  });
}

function createSocksAgent(proxy: ParsedCloudProxy): SocksProxyAgent {
  const agent = new SocksProxyAgent(proxy.href);
  if (proxy.hostname.startsWith("[") && proxy.hostname.endsWith("]")) agent.proxy.host = proxy.hostname.slice(1, -1);
  return agent;
}
