import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** Resolve a hostname to its addresses; injectable for tests. */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

/**
 * Address ranges a model-callable fetch must not reach: loopback, private,
 * link-local, CGNAT, documentation, benchmarking, multicast, and reserved
 * space, for both IPv4 and IPv6 (including NAT64 and IPv4-mapped forms).
 */
const blocked = new BlockList();
blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4");
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.0.0.0", 24, "ipv4");
blocked.addSubnet("192.0.2.0", 24, "ipv4");
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addSubnet("198.18.0.0", 15, "ipv4");
blocked.addSubnet("198.51.100.0", 24, "ipv4");
blocked.addSubnet("203.0.113.0", 24, "ipv4");
blocked.addSubnet("224.0.0.0", 4, "ipv4");
blocked.addSubnet("240.0.0.0", 4, "ipv4");
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("ff00::", 8, "ipv6");
blocked.addSubnet("64:ff9b::", 96, "ipv6");

/**
 * Normalize an IPv4 literal, including decimal, hex, octal, and IPv4-mapped
 * IPv6 forms. Browsers accept these spellings, so a string comparison on the
 * dotted form is not enough.
 */
export function normalizeIpv4Address(address: string): string | undefined {
  const bare = address.replace(/^\[/, "").replace(/\]$/, "").replace(/%.*$/, "").toLowerCase();
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped) return normalizeIpv4Address(mapped[1]);
  const single = /^0x[0-9a-f]+$/.test(bare)
    ? Number.parseInt(bare.slice(2), 16)
    : /^0[0-7]+$/.test(bare)
      ? Number.parseInt(bare.slice(1), 8)
      : /^\d+$/.test(bare)
        ? Number(bare)
        : undefined;
  if (single !== undefined) {
    if (!Number.isSafeInteger(single) || single < 0 || single > 0xffffffff) return undefined;
    return [single >>> 24, (single >>> 16) & 0xff, (single >>> 8) & 0xff, single & 0xff].join(".");
  }
  const parts = bare.split(".");
  if (parts.length !== 4) return undefined;
  const numbers = parts.map((part) => {
    if (/^0x[0-9a-f]+$/.test(part)) return Number.parseInt(part.slice(2), 16);
    if (/^0[0-7]+$/.test(part)) return Number.parseInt(part.slice(1), 8);
    if (/^\d+$/.test(part)) return Number.parseInt(part, 10);
    return Number.NaN;
  });
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return undefined;
  }
  return numbers.join(".");
}

/** True when a literal IP address is in a blocked (private or non-routable) range. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[/, "").replace(/\]$/, "").replace(/%.*$/, "");
  const ipv4 = normalizeIpv4Address(bare);
  try {
    if (ipv4) return blocked.check(ipv4, "ipv4");
    const family = isIP(bare);
    if (family === 4) return blocked.check(bare, "ipv4");
    if (family === 6) return blocked.check(bare, "ipv6");
  } catch {
    return false;
  }
  return false;
}

/**
 * Hostnames that name a metadata service or a local-machine alias rather than
 * a routable site. Kept deliberately small; resolution still catches aliases
 * that map to a private address.
 */
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

/** True when a hostname is a local alias or a known cloud metadata service. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.+$/, "").toLowerCase();
  return host.endsWith(".localhost") || BLOCKED_HOSTNAMES.has(host);
}

export interface GuardOptions {
  /** Skip the guard entirely, for local development. */
  allowPrivateHosts: boolean;
  resolve?: ResolveHost;
}

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether a URL may be fetched: only `http`/`https`, and unless
 * private hosts are allowed, no loopback/private/link-local/metadata target.
 * The host is resolved and every address is checked, a best-effort defense
 * against DNS rebinding.
 */
export async function checkUrlAllowed(url: string, options: GuardOptions): Promise<GuardResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `Invalid URL: ${url}` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `Unsupported URL scheme: ${parsed.protocol}` };
  }

  if (options.allowPrivateHosts) return { allowed: true };

  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isBlockedHostname(host)) {
    return { allowed: false, reason: `Blocked private host: ${host}` };
  }
  if (isIP(host)) {
    return isPrivateAddress(host)
      ? { allowed: false, reason: `Blocked private address: ${host}` }
      : { allowed: true };
  }

  const resolve = options.resolve ?? defaultResolve;
  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    return { allowed: false, reason: `Could not resolve host: ${host}` };
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: `Could not resolve host: ${host}` };
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      return { allowed: false, reason: `Blocked private address ${address} for ${host}` };
    }
  }
  return { allowed: true };
}

async function defaultResolve(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}
