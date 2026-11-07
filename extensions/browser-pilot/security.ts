import { checkUrlAllowed, normalizeIpv4Address, type GuardResult } from "../../lib/security";

/** Cloud metadata endpoints that stay blocked even when private hosts are allowed. */
const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "metadata.azure.com",
]);

/** Cloud metadata addresses, including ECS and Alibaba metadata services. */
const METADATA_ADDRESSES = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "fd00:ec2::254",
]);

/** Lowercase a hostname and remove brackets and a trailing root dot. */
function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.+$/, "").toLowerCase();
}

/**
 * Guard a top-level navigation. Only `http(s)` is allowed. Cloud metadata
 * endpoints are always rejected, including alternate IPv4 spellings; other
 * private hosts are allowed only when the configuration opts in, because local
 * development is a primary use case.
 */
export async function checkNavigationAllowed(
  url: string,
  allowPrivateHosts: boolean,
): Promise<GuardResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `Invalid URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `Unsupported URL scheme: ${parsed.protocol}` };
  }
  const host = normalizeHost(parsed.hostname);
  if (isMetadataHost(host)) {
    return { allowed: false, reason: `Blocked cloud metadata host: ${host}` };
  }
  if (allowPrivateHosts) return { allowed: true };
  return checkUrlAllowed(url, { allowPrivateHosts: false });
}

/** True when a host is a known cloud metadata endpoint or address. */
export function isMetadataHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (METADATA_HOSTS.has(host)) return true;
  if (METADATA_ADDRESSES.has(host)) return true;
  const ipv4 = normalizeIpv4Address(host);
  return ipv4 !== undefined && METADATA_ADDRESSES.has(ipv4);
}
