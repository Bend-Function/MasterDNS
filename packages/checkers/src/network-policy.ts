import { isIP } from "node:net";

export type NetworkTargetPolicy = {
  allowPrivate?: boolean;
  allowLoopback?: boolean;
};

export function assertAllowedNetworkTarget(address: string, policy: NetworkTargetPolicy = {}): void {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    if (isBlockedIpv4(octets, Boolean(policy.allowPrivate), Boolean(policy.allowLoopback))) throw blockedAddressError(address);
    return;
  }
  if (family === 6) {
    const normalized = normalizeIpv6(address);
    if (isBlockedIpv6(normalized, Boolean(policy.allowPrivate), Boolean(policy.allowLoopback))) throw blockedAddressError(address);
    return;
  }
  throw Object.assign(new Error("Health check target must be an IP address"), { code: "invalid_target" });
}

function isBlockedIpv4(octets: number[], allowPrivate: boolean, allowLoopback = false): boolean {
  const [a = -1, b = -1] = octets;
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  if (a === 0 || (a === 127 && !allowLoopback) || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 0 && octets[2] === 0) return true;
  if (a === 192 && b === 0 && octets[2] === 2) return true;
  if (a === 198 && [18, 19].includes(b)) return true;
  if (a === 198 && b === 51 && octets[2] === 100) return true;
  if (a === 203 && b === 0 && octets[2] === 113) return true;
  if (!allowPrivate && (
    a === 10
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
  )) return true;
  return false;
}

function normalizeIpv6(address: string): bigint {
  const withoutZone = address.split("%", 1)[0] ?? address;
  const [head = "", tail = ""] = withoutZone.toLowerCase().split("::", 2);
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const expandIpv4 = (parts: string[]) => parts.flatMap((part) => {
    if (!part.includes(".")) return [part];
    const bytes = part.split(".").map(Number);
    return [((bytes[0] ?? 0) * 256 + (bytes[1] ?? 0)).toString(16), ((bytes[2] ?? 0) * 256 + (bytes[3] ?? 0)).toString(16)];
  });
  const expandedHead = expandIpv4(headParts);
  const expandedTail = expandIpv4(tailParts);
  const missing = Math.max(0, 8 - expandedHead.length - expandedTail.length);
  const parts = withoutZone.includes("::")
    ? [...expandedHead, ...Array.from({ length: missing }, () => "0"), ...expandedTail]
    : expandedHead;
  if (parts.length !== 8) throw blockedAddressError(address);
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part || "0"}`), 0n);
}

const IPV6_PREFIX = {
  multicast: normalizeIpv6("ff00::"),
  linkLocal: normalizeIpv6("fe80::"),
  siteLocal: normalizeIpv6("fec0::"),
  uniqueLocal: normalizeIpv6("fc00::"),
  globalUnicast: normalizeIpv6("2000::"),
  special2001: normalizeIpv6("2001::"),
  documentation: normalizeIpv6("2001:db8::"),
  sixToFour: normalizeIpv6("2002::"),
  documentationV2: normalizeIpv6("3fff::"),
};

function isBlockedIpv6(value: bigint, allowPrivate: boolean, allowLoopback = false): boolean {
  if (value === 0n) return true;
  if (value === 1n) return !allowLoopback;
  const mappedPrefix = value >> 32n;
  if (mappedPrefix === 0xffffn) {
    const ipv4 = Number(value & 0xffffffffn);
    return isBlockedIpv4([
      (ipv4 >>> 24) & 255,
      (ipv4 >>> 16) & 255,
      (ipv4 >>> 8) & 255,
      ipv4 & 255,
    ], allowPrivate, allowLoopback);
  }
  if (hasIpv6Prefix(value, IPV6_PREFIX.multicast, 8)) return true;
  if (hasIpv6Prefix(value, IPV6_PREFIX.linkLocal, 10) || hasIpv6Prefix(value, IPV6_PREFIX.siteLocal, 10)) return true;
  if (hasIpv6Prefix(value, IPV6_PREFIX.uniqueLocal, 7)) return !allowPrivate;

  // Only globally routed unicast is accepted by default. This also rejects
  // IPv4-compatible, NAT64 and other special-purpose translation ranges.
  if (!hasIpv6Prefix(value, IPV6_PREFIX.globalUnicast, 3)) return true;
  if (hasIpv6Prefix(value, IPV6_PREFIX.special2001, 23)) return true;
  if (hasIpv6Prefix(value, IPV6_PREFIX.documentation, 32)) return true;
  if (hasIpv6Prefix(value, IPV6_PREFIX.sixToFour, 16)) return true;
  if (hasIpv6Prefix(value, IPV6_PREFIX.documentationV2, 20)) return true;
  return false;
}

function hasIpv6Prefix(value: bigint, prefix: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return value >> shift === prefix >> shift;
}

function blockedAddressError(address: string): Error {
  return Object.assign(new Error(`Network target ${address} is not allowed`), { code: "target_not_allowed" });
}
