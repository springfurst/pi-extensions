/**
 * Browser profiles and the instance records that make a running browser
 * discoverable from another process.
 *
 * A profile is a Chromium user-data directory plus a stable key. The instance
 * record next to it says which pid, port, and DevTools endpoint currently serve
 * that profile, so a second process can attach instead of failing on a locked
 * profile directory.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { expandTilde } from "../logging";

/** Default shared profile name. */
export const DEFAULT_PROFILE = "shared";

const INSTANCE_SCHEMA = 1;
const PROBE_TIMEOUT_MS = 2_000;

/** Where a profile lives and whether it survives the session. */
export interface ProfileInfo {
  /** Short stable key used for the instance record filename. */
  key: string;
  /** Absolute user-data-dir. */
  userDataDir: string;
  /** Human-facing profile name or path. */
  label: string;
  /** True when the profile is reused across sessions. */
  persistent: boolean;
}

/** One live Chrome process and its DevTools endpoint. */
export interface ChromeInstance {
  pid: number;
  port: number;
  wsEndpoint: string;
  userDataDir: string;
  executablePath: string;
  startedAt: string;
  ownerSessionId: string;
  chromeVersion?: string;
  /** True when the browser was attached to rather than launched. */
  external?: boolean;
}

/** Persisted per-profile instance record. */
export interface InstanceRecord extends ChromeInstance {
  schema: number;
}

/** Resolve a profile name or path into an absolute user-data-dir. */
export function resolveProfile(
  profile: string,
  sessionId: string,
  agentDir: string,
  cwd: string,
): ProfileInfo {
  const raw = profile.trim() || DEFAULT_PROFILE;
  if (raw === "session") {
    const id = sanitizeName(sessionId || `pid-${process.pid}`);
    return {
      key: `session-${id}`,
      userDataDir: join(agentDir, "browser-pilot", "profiles", "sessions", id),
      label: `session:${id}`,
      persistent: false,
    };
  }
  if (raw === DEFAULT_PROFILE) return namedProfile(agentDir, DEFAULT_PROFILE);
  if (isPathLike(raw)) {
    const userDataDir = resolveUserPath(raw, cwd);
    return {
      key: `path-${shortHash(userDataDir)}`,
      userDataDir,
      label: userDataDir,
      persistent: true,
    };
  }
  return namedProfile(agentDir, raw);
}

function namedProfile(agentDir: string, name: string): ProfileInfo {
  const id = sanitizeName(name);
  return {
    key: id,
    userDataDir: join(agentDir, "browser-pilot", "profiles", id),
    label: id,
    persistent: true,
  };
}

function isPathLike(value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith("~") ||
    value.startsWith(".") ||
    value.includes("/") ||
    value.includes("\\")
  );
}

/** Expand `~` and resolve a relative path against the working directory. */
export function resolveUserPath(value: string, cwd: string): string {
  const expanded = expandTilde(value);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function sanitizeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64) || "default";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Path of the per-profile instance record. */
export function instanceRecordPath(agentDir: string, profileKey: string): string {
  return join(agentDir, "browser-pilot", "instances", `${sanitizeName(profileKey)}.json`);
}

/** Read and validate an instance record. Malformed records are ignored. */
export function readInstanceRecord(path: string): InstanceRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<InstanceRecord>;
    if (
      parsed.schema !== INSTANCE_SCHEMA ||
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number" ||
      typeof parsed.wsEndpoint !== "string" ||
      typeof parsed.userDataDir !== "string" ||
      typeof parsed.executablePath !== "string" ||
      typeof parsed.startedAt !== "string"
    ) {
      return undefined;
    }
    return {
      ...parsed,
      ownerSessionId: typeof parsed.ownerSessionId === "string" ? parsed.ownerSessionId : "",
    } as InstanceRecord;
  } catch {
    return undefined;
  }
}

/** Persist one instance record. Best-effort. */
export function writeInstanceRecord(path: string, record: InstanceRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // The record is an optimization for reconnects, not a correctness requirement.
  }
}

/** Remove an instance record. */
export function removeInstanceRecord(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort.
  }
}

/** True when a pid exists. EPERM means the process exists but is owned by someone else. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ProbeResult {
  wsEndpoint: string;
  chromeVersion?: string;
}

/** Ask a DevTools HTTP endpoint for its websocket URL. */
export async function probeInstance(
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as {
      webSocketDebuggerUrl?: unknown;
      Browser?: unknown;
    };
    if (typeof data.webSocketDebuggerUrl !== "string") return undefined;
    return {
      wsEndpoint: data.webSocketDebuggerUrl,
      chromeVersion: typeof data.Browser === "string" ? data.Browser : undefined,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
