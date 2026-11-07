import { checkUrlAllowed, type GuardResult } from "../../lib/security";

/** Cloud metadata endpoints that stay blocked even when private hosts are allowed. */
const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "169.254.169.254",
  "100.100.100.200",
  "fd00:ec2::254",
]);

/**
 * Guard a top-level navigation. Only `http(s)` is allowed. Cloud metadata
 * endpoints are always rejected; other private hosts are allowed only when the
 * configuration opts in, because local development is a primary use case.
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
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (METADATA_HOSTS.has(host)) {
    return { allowed: false, reason: `Blocked cloud metadata host: ${host}` };
  }
  if (allowPrivateHosts) return { allowed: true };
  return checkUrlAllowed(url, { allowPrivateHosts: false });
}

/** True when a host is a known cloud metadata endpoint. */
export function isMetadataHost(hostname: string): boolean {
  return METADATA_HOSTS.has(hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase());
}
