import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { assertAllowedNetworkTarget, type NetworkTargetPolicy } from "@masterdns/checkers";
import { Agent, request } from "undici";

export type OutboundJsonRequestOptions = {
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  policy?: NetworkTargetPolicy;
  resolve?: typeof resolveHost;
};

export async function postJsonToAllowedUrl(endpoint: string, options: OutboundJsonRequestOptions): Promise<number> {
  const target = new URL(endpoint);
  if (!new Set(["http:", "https:"]).has(target.protocol)) throw outboundError("unsupported_protocol");
  if (target.username || target.password) throw outboundError("url_credentials_not_allowed");
  const resolve = options.resolve ?? resolveHost;
  const addresses = await resolve(target.hostname);
  if (addresses.length === 0) throw outboundError("target_resolution_failed");
  for (const address of addresses) assertAllowedNetworkTarget(address.address, options.policy);
  const selected = addresses[0];
  if (!selected) throw outboundError("target_resolution_failed");

  const dispatcher = new Agent({
    connect: {
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, addresses);
        else callback(null, selected.address, selected.family);
      },
    },
  });
  try {
    const response = await request(target, {
      method: "POST",
      headers: options.headers,
      body: options.body,
      dispatcher,
      headersTimeout: options.timeoutMs,
      bodyTimeout: options.timeoutMs,
    });
    await discardBody(response.body);
    return response.statusCode;
  } finally {
    await dispatcher.close();
  }
}

async function resolveHost(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const family = isIP(hostname);
  if (family) return [{ address: hostname, family: family as 4 | 6 }];
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((address) => ({ address: address.address, family: address.family as 4 | 6 }));
}

async function discardBody(body: AsyncIterable<unknown>): Promise<void> {
  let size = 0;
  for await (const chunk of body) {
    size += Buffer.isBuffer(chunk) ? chunk.length : Buffer.from(chunk as Uint8Array).length;
    if (size > 64 * 1024) {
      (body as AsyncIterable<unknown> & { destroy?: () => void }).destroy?.();
      break;
    }
  }
}

function outboundError(code: string): Error {
  return Object.assign(new Error(code), { code });
}
