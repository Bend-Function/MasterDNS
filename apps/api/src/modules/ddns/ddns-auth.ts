import { UnauthorizedException } from "@nestjs/common";
import { isIP } from "node:net";

const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

export function parseDdnsBearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer[ \t]+([^ \t]+)$/i);
  if (!match?.[1] || !OPAQUE_TOKEN.test(match[1])) {
    throw new UnauthorizedException("缺少有效的 DDNS 运行 Token");
  }
  return match[1];
}

export function normalizeDdnsSourceIp(value: string): string | undefined {
  const unwrapped = value.toLowerCase().startsWith("::ffff:") ? value.slice(7) : value;
  return isIP(unwrapped) ? unwrapped : undefined;
}
