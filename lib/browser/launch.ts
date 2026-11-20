/**
 * Launching, discovering, connecting to, and closing Chrome for a profile.
 *
 * The process is started detached with a DevTools port on loopback. A record
 * next to the profile directory remembers the endpoint, so any process can
 * attach to the same browser instead of fighting over the profile lock.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Browser } from "puppeteer-core";
import { resolveBrowserExecutable } from "../browser";
import {
  instanceRecordPath,
  pidAlive,
  probeInstance,
  readInstanceRecord,
  removeInstanceRecord,
  resolveProfile,
  resolveUserPath,
  writeInstanceRecord,
  type ChromeInstance,
  type InstanceRecord,
  type ProfileInfo,
} from "./profile";

const execFileAsync = promisify(execFile);
const INSTANCE_SCHEMA = 1;
const LAUNCH_TIMEOUT_MS = 20_000;

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

/** The configuration fields a launch needs. */
export interface ChromeLaunchConfig {
  executablePath?: string;
  profile: string;
  headless: boolean | "auto";
  viewport: { width: number; height: number };
  locale?: string;
  stealth: "off" | "basic" | "careful";
  noSandbox: boolean;
  args: string[];
}

/** True when the configuration asks for headless rendering or no display exists. */
export function shouldRunHeadless(
  config: Pick<ChromeLaunchConfig, "headless">,
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
  config: Pick<ChromeLaunchConfig, "viewport" | "stealth" | "locale" | "noSandbox" | "args">,
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

export interface SpawnChromeOptions {
  executablePath: string;
  profile: ProfileInfo;
  config: ChromeLaunchConfig;
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

/**
 * What to do with an existing instance record: attach to it, ignore it, or
 * refuse because another session owns it and attaching is disabled.
 */
export type ExistingInstanceDecision =
  | { action: "reuse"; instance: InstanceRecord }
  | { action: "ignore" }
  | { action: "refuse"; instance: InstanceRecord }
  | { action: "kill"; instance: InstanceRecord };

/** Decide how to treat a live process found in the profile's instance record. */
export function decideExistingInstance(options: {
  record: InstanceRecord | undefined;
  sessionId: string;
  attach: boolean;
  alive: boolean;
  probe?: { wsEndpoint: string; chromeVersion?: string };
}): ExistingInstanceDecision {
  const { record } = options;
  if (!record) return { action: "ignore" };
  if (!options.alive) return { action: "ignore" };
  const sameSession = !record.ownerSessionId || record.ownerSessionId === options.sessionId;
  if (options.probe) {
    if (sameEndpoint(options.probe.wsEndpoint, record.wsEndpoint)) {
      return {
        action: "reuse",
        instance: {
          ...record,
          wsEndpoint: options.probe.wsEndpoint,
          chromeVersion: options.probe.chromeVersion ?? record.chromeVersion,
        },
      };
    }
    // The port now belongs to a different browser; do not kill a pid we cannot verify.
    return { action: "ignore" };
  }
  if (options.attach) return { action: "reuse", instance: record };
  if (sameSession) return { action: "kill", instance: record };
  return { action: "refuse", instance: record };
}

export interface EnsureChromeOptions {
  config: ChromeLaunchConfig;
  sessionId: string;
  agentDir: string;
  cwd: string;
  /** Attach to a live endpoint for the profile instead of failing on it. */
  attach?: boolean;
  signal?: AbortSignal;
}

/** Resolve the binary, then reuse or spawn the profile's Chrome process. */
export async function ensureChrome(
  options: EnsureChromeOptions,
): Promise<{ instance: ChromeInstance; profile: ProfileInfo; attached: boolean }> {
  const attach = options.attach ?? true;
  const profile = resolveProfile(
    options.config.profile,
    options.sessionId,
    options.agentDir,
    options.cwd,
  );
  const recordPath = instanceRecordPath(options.agentDir, profile.key);
  const existing = readInstanceRecord(recordPath);

  if (existing) {
    const decision = decideExistingInstance({
      record: existing,
      sessionId: options.sessionId,
      attach,
      alive: pidAlive(existing.pid),
      probe: await maybeProbe(existing),
    });
    if (decision.action === "reuse") {
      writeInstanceRecord(recordPath, { ...decision.instance, schema: INSTANCE_SCHEMA });
      return { profile, instance: decision.instance, attached: true };
    }
    if (decision.action === "refuse") {
      throw new ProfileInUseError(profile, decision.instance);
    }
    if (decision.action === "kill") {
      await killProcessTree(decision.instance.pid);
    }
    removeInstanceRecord(recordPath);
  }

  const executablePath = await resolveBrowserExecutable({
    executablePath: options.config.executablePath
      ? resolveUserPath(options.config.executablePath, options.cwd)
      : undefined,
    preferConfigured: true,
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
  return { instance, profile, attached: false };
}

async function maybeProbe(
  record: InstanceRecord,
): Promise<{ wsEndpoint: string; chromeVersion?: string } | undefined> {
  if (!pidAlive(record.pid)) return undefined;
  return probeInstance(record.port);
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

function lastLines(stderr: string): string {
  return stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n");
}

function sameEndpoint(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.port === right.port && left.pathname === right.pathname;
  } catch {
    return a === b;
  }
}

function profileInUseText(stderr: string): boolean {
  return /profile.*in use|ProcessSingleton|SingletonLock|already running|Failed to create a ProcessSingleton/i.test(
    stderr,
  );
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

async function withTimeout<T>(promise: T | Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
