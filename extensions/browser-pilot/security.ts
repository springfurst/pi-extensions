import { existsSync } from "node:fs";
import { isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expandTilde } from "../../lib/logging";
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

/** A leading URL scheme such as `https:`. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** A Windows drive path such as `C:\page.html`, which the scheme test would misread. */
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;

/** Lowercase a hostname and remove brackets and a trailing root dot. */
function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.+$/, "").toLowerCase();
}

/** Everything the navigation guard needs from the configuration and the call. */
export interface NavigationGuardOptions {
  /** Allow loopback, private, and link-local hosts. */
  allowPrivateHosts: boolean;
  /** Allow navigation to local files whose path matches `localFileGlobs`. */
  allowLocalFiles?: boolean;
  /** Globs of allowed local files. Relative globs resolve against `cwd`. */
  localFileGlobs?: readonly string[];
  /** Working directory for relative paths and relative globs. */
  cwd?: string;
}

/** A guard decision, plus the URL to navigate to when the input was a local path. */
export interface NavigationGuardResult extends GuardResult {
  /** The resolved URL. A local path is rewritten to a `file:` URL. */
  url?: string;
}

/**
 * Guard a top-level navigation.
 *
 * `http(s)` is always allowed, minus cloud metadata endpoints and, unless the
 * configuration opts in, loopback and private hosts. Local files are allowed
 * only when `allowLocalFiles` is enabled and the resolved path matches one of
 * `localFileGlobs`; a bare filesystem path is accepted in that case and
 * rewritten to a `file:` URL. Every other scheme is rejected.
 */
export async function checkNavigationAllowed(
  input: string,
  options: NavigationGuardOptions,
): Promise<NavigationGuardResult> {
  const target = input.trim();
  if (!target) return { allowed: false, reason: "Empty URL." };

  const localPath = localPathOf(target, options.cwd);
  if (localPath) return guardLocalFile(localPath, options);

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return { allowed: false, reason: `Invalid URL: ${input}` };
  }
  if (parsed.protocol === "file:") {
    return guardLocalFile(fileURLToPath(parsed), options);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `Unsupported URL scheme: ${parsed.protocol}` };
  }
  const host = normalizeHost(parsed.hostname);
  if (isMetadataHost(host)) {
    return { allowed: false, reason: `Blocked cloud metadata host: ${host}` };
  }
  // Hand the caller its own string back, so a permitted navigation is unchanged.
  if (options.allowPrivateHosts) return { allowed: true, url: target };
  return checkUrlAllowed(target, { allowPrivateHosts: false });
}

/**
 * The absolute path when the input names a local file rather than a URL, or
 * undefined when the input should be parsed as a URL. A bare path counts when it
 * exists or is written as one, so `page.html` is a file and `example.com` is not.
 */
function localPathOf(target: string, cwd: string | undefined): string | undefined {
  if (SCHEME.test(target) && !WINDOWS_DRIVE_PATH.test(target)) return undefined;
  const writtenAsPath =
    target.startsWith(".") ||
    target.startsWith("/") ||
    target.startsWith("\\") ||
    target.startsWith("~") ||
    WINDOWS_DRIVE_PATH.test(target);
  const absolute = resolveLocalPath(target, cwd);
  if (!writtenAsPath && !existsSync(absolute)) return undefined;
  return absolute;
}

/** Resolve a user-supplied path against the working directory, expanding a leading `~`. */
function resolveLocalPath(target: string, cwd: string | undefined): string {
  const expanded = expandTilde(target);
  return isAbsolute(expanded) ? expanded : resolve(cwd ?? process.cwd(), expanded);
}

/** Decide whether a resolved local path may be opened, and build its `file:` URL. */
function guardLocalFile(path: string, options: NavigationGuardOptions): NavigationGuardResult {
  const display = path;
  if (!options.allowLocalFiles) {
    return {
      allowed: false,
      reason: `Local file navigation is disabled: ${display}`,
    };
  }
  const globs = (options.localFileGlobs ?? []).map((glob) => glob.trim()).filter(Boolean);
  if (globs.length === 0) {
    return {
      allowed: false,
      reason: `No localFileGlobs are configured, so ${display} is not allowed.`,
    };
  }
  if (!matchesLocalGlobs(path, globs, options.cwd)) {
    return {
      allowed: false,
      reason: `Local file ${display} does not match localFileGlobs (${globs.join(", ")}).`,
    };
  }
  return { allowed: true, url: pathToFileURL(path).href };
}

/** True when the path matches one of the globs. Relative globs stay inside `cwd`. */
export function matchesLocalGlobs(
  path: string,
  globs: readonly string[],
  cwd: string | undefined,
): boolean {
  const root = cwd ?? process.cwd();
  const fromRoot = relative(root, path);
  const insideRoot = fromRoot.length > 0 && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
  for (const glob of globs) {
    if (isAbsolute(glob)) {
      if (matchesGlob(path, glob)) return true;
      continue;
    }
    if (insideRoot && matchesGlob(fromRoot, glob)) return true;
  }
  return false;
}

/** True when a host is a known cloud metadata endpoint or address. */
export function isMetadataHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (METADATA_HOSTS.has(host)) return true;
  if (METADATA_ADDRESSES.has(host)) return true;
  const ipv4 = normalizeIpv4Address(host);
  return ipv4 !== undefined && METADATA_ADDRESSES.has(ipv4);
}
