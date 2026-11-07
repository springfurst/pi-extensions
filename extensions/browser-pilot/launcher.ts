import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Browser } from "puppeteer-core";
import { resolveBrowserExecutable } from "../../lib/browser";
import { expandTilde } from "../../lib/logging";
import { DEFAULT_PROFILE } from "./config";
import type { BrowserPilotConfig, ChromeInstance, InstanceRecord, ProfileInfo } from "./types";

const execFileAsync = promisify(execFile);
const INSTANCE_SCHEMA = 1;
const LAUNCH_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 2_000;

/** Chrome exited or never exposed a DevTools endpoint. */
export class ChromeLaunchError extends Error {
  constructor(
    message: string,
    readonly profile: ProfileInfo,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ChromeLaunchError";
  }
}

/** The profile is held by a live Chrome process owned by another session. */
export class ProfileInUseError extends Error {
  constructor(
    readonly profile: ProfileInfo,
    readonly record: InstanceRecord,
  ) {
    const owner = record.ownerSessionId ? `, session ${record.ownerSessionId}` : "";
    super(
      `Profile "${profile.label}" is already in use by another Chrome process ` +
        `(pid ${record.pid}, port ${record.port}${owner}). ` +
        `Close that browser, or use profile:"session" or a named profile.`,
    );
    this.name = "ProfileInUseError";
  }
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
  if (raw === "shared") return namedProfile(agentDir, DEFAULT_PROFILE);
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

function resolveUserPath(value: string, cwd: string): string {
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

interface ProbeResult {
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

/** True when the configuration asks for headless rendering or no display exists. */
export function shouldRunHeadless(
  config: Pick<BrowserPilotConfig, "headless">,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (config.headless === true) return true;
  if (config.headless === false) return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  return false;
}

/** Build the Chrome command line. */
export function buildChromeArgs(
  config: Pick<BrowserPilotConfig, "viewport" | "stealth" | "locale" | "noSandbox" | "args">,
  userDataDir: string,
  headless: boolean,
): string[] {
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--disable-dev-shm-usage",
    `--window-size=${config.viewport.width},${config.viewport.height}`,
  ];
  if (headless) args.push("--headless=new");
  if (config.stealth !== "off") args.push("--disable-blink-features=AutomationControlled");
  if (config.locale) args.push(`--lang=${config.locale}`);
  if (config.noSandbox) args.push("--no-sandbox", "--disable-setuid-sandbox");
  args.push(...config.args);
  return args;
}

/** Read Chrome's `DevToolsActivePort` file. */
export function readDevToolsActivePort(
  path: string,
): { port: number; wsEndpoint: string } | undefined {
  try {
    const lines = readFileSync(path, "utf-8").split(/\r?\n/);
    const port = Number.parseInt(lines[0] ?? "", 10);
    const wsPath = (lines[1] ?? "").trim();
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
    if (!wsPath.startsWith("/")) return undefined;
    return { port, wsEndpoint: `ws://127.0.0.1:${port}${wsPath}` };
  } catch {
    return undefined;
  }
}

interface SpawnChromeOptions {
  executablePath: string;
  profile: ProfileInfo;
  config: BrowserPilotConfig;
  sessionId: string;
  headless: boolean;
  signal?: AbortSignal;
}

/** Spawn Chrome, wait for its DevTools endpoint, and return the instance record. */
export async function spawnChrome(options: SpawnChromeOptions): Promise<ChromeInstance> {
  mkdirSync(options.profile.userDataDir, { recursive: true, mode: 0o700 });
  const portFile = join(options.profile.userDataDir, "DevToolsActivePort");
  rmSync(portFile, { force: true });

  const args = buildChromeArgs(options.config, options.profile.userDataDir, options.headless);
  const child = spawn(options.executablePath, args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: false,
  });
  child.unref();

  let stderr = "";
  let stderrWs: string | undefined;
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
    if (match) stderrWs = match[1];
  });

  const pid = child.pid;
  if (!pid) {
    throw new ChromeLaunchError("Chrome did not provide a process id.", options.profile, stderr);
  }

  let exitCode: number | null = null;
  child.once("exit", (code) => {
    exitCode = code;
  });

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      if (exitCode !== null) {
        const detail = lastLines(stderr);
        throw new ChromeLaunchError(
          profileInUseText(stderr)
            ? `Profile "${options.profile.label}" is already in use by another Chrome process. ` +
                `Close that browser, or use profile:"session" or a named profile.`
            : `Chrome exited before exposing a DevTools port (exit ${exitCode}). ` +
                `The profile may be in use by another Chrome process.${detail ? `\n${detail}` : ""}`,
          options.profile,
          stderr,
        );
      }

      const fromFile = readDevToolsActivePort(portFile);
      if (fromFile) {
        const probe = await probeInstance(fromFile.port);
        return {
          pid,
          port: fromFile.port,
          wsEndpoint: probe?.wsEndpoint ?? fromFile.wsEndpoint,
          userDataDir: options.profile.userDataDir,
          executablePath: options.executablePath,
          startedAt: new Date().toISOString(),
          ownerSessionId: options.sessionId,
          chromeVersion: probe?.chromeVersion,
        };
      }

      if (stderrWs) {
        const parsed = new URL(stderrWs);
        const port = Number.parseInt(parsed.port, 10);
        if (Number.isInteger(port) && port > 0) {
          const probe = await probeInstance(port);
          return {
            pid,
            port,
            wsEndpoint: probe?.wsEndpoint ?? stderrWs,
            userDataDir: options.profile.userDataDir,
            executablePath: options.executablePath,
            startedAt: new Date().toISOString(),
            ownerSessionId: options.sessionId,
            chromeVersion: probe?.chromeVersion,
          };
        }
      }

      await sleep(100);
    }

    const detail = lastLines(stderr);
    throw new ChromeLaunchError(
      `Chrome did not expose a DevTools port within ${LAUNCH_TIMEOUT_MS / 1000}s.` +
        (detail ? `\n${detail}` : ""),
      options.profile,
      stderr,
    );
  } catch (error) {
    await killProcessTree(pid);
    throw error;
  }
}

function lastLines(stderr: string): string {
  return stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n");
}

function profileInUseText(stderr: string): boolean {
  return /profile.*in use|ProcessSingleton|SingletonLock|already running|Failed to create a ProcessSingleton/i.test(
    stderr,
  );
}

/** Resolve the binary, then reuse or spawn the profile's Chrome process. */
export async function ensureChrome(options: {
  config: BrowserPilotConfig;
  sessionId: string;
  agentDir: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<{ instance: ChromeInstance; profile: ProfileInfo }> {
  const profile = resolveProfile(
    options.config.profile,
    options.sessionId,
    options.agentDir,
    options.cwd,
  );
  const recordPath = instanceRecordPath(options.agentDir, profile.key);
  const existing = readInstanceRecord(recordPath);

  if (existing) {
    const sameSession = !existing.ownerSessionId || existing.ownerSessionId === options.sessionId;
    if (pidAlive(existing.pid)) {
      const probe = await probeInstance(existing.port);
      if (probe && (!existing.wsEndpoint || probe.wsEndpoint === existing.wsEndpoint)) {
        if (!sameSession) throw new ProfileInUseError(profile, existing);
        return {
          profile,
          instance: {
            ...existing,
            wsEndpoint: probe.wsEndpoint,
            chromeVersion: probe.chromeVersion ?? existing.chromeVersion,
          },
        };
      }
      if (probe) {
        // The port now belongs to a different browser. Do not kill a pid we cannot verify.
        removeInstanceRecord(recordPath);
      } else if (!sameSession) {
        throw new ProfileInUseError(profile, existing);
      } else {
        // This session owns a live but unresponsive process. Kill it before relaunching.
        await killProcessTree(existing.pid);
        removeInstanceRecord(recordPath);
      }
    } else {
      removeInstanceRecord(recordPath);
    }
  }

  const executablePath = await resolveBrowserExecutable({
    executablePath: options.config.executablePath
      ? expandTilde(options.config.executablePath)
      : undefined,
  });
  if (!executablePath) {
    throw new Error(
      "No Chrome, Chromium, or Edge binary was found. Install one, or set " +
        "browser-pilot.json executablePath / BROWSER_PILOT_EXECUTABLE_PATH / PUPPETEER_EXECUTABLE_PATH.",
    );
  }

  const headless = shouldRunHeadless(options.config);
  const instance = await spawnChrome({
    executablePath,
    profile,
    config: options.config,
    sessionId: options.sessionId,
    headless,
    signal: options.signal,
  });
  writeInstanceRecord(recordPath, { ...instance, schema: INSTANCE_SCHEMA });
  return { instance, profile };
}

/** Connect to a Chrome instance through puppeteer-core. */
export async function connectChrome(instance: ChromeInstance): Promise<Browser> {
  const { connect } = await import("puppeteer-core");
  return connect({
    browserWSEndpoint: instance.wsEndpoint,
    defaultViewport: null,
    protocolTimeout: 60_000,
  });
}

/** Close a browser and kill any remaining process tree. */
export async function closeChrome(options: {
  browser?: Browser;
  pid?: number;
  recordPath?: string;
  userDataDir?: string;
  deleteProfile?: boolean;
}): Promise<void> {
  if (options.browser) {
    await withTimeout(options.browser.close(), 5_000).catch(() => undefined);
  }
  if (options.pid && pidAlive(options.pid)) {
    await killProcessTree(options.pid);
  }
  if (options.recordPath) removeInstanceRecord(options.recordPath);
  if (options.deleteProfile && options.userDataDir) {
    try {
      rmSync(options.userDataDir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
}

/** Synchronous process-tree kill for process-exit cleanup. */
export function disposeChromeSync(pid: number): void {
  if (!pidAlive(pid)) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5_000,
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    // Best effort.
  }
}

async function killProcessTree(pid: number): Promise<void> {
  if (!pidAlive(pid)) return;
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      timeout: 5_000,
    }).catch(() => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  await sleep(500);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
