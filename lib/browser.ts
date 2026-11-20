// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { BrowserConfig } from "./config";
import type { BlockingConfig, HostPolicy, RuntimeConfig } from "./web/config";
import type { Politeness } from "./web/politeness";
import type { BrowserRuntime, BrowserRuntimeOptions } from "./browser/runtime";
import { isBlockedHostname, isPrivateAddress, type ResolveHost } from "./security";

/** One page rendered through a real browser: final HTML, status, and URL. */
export interface RenderedPage {
  html: string;
  status: number;
  finalUrl: string;
}

export interface RenderPageOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Warm cookies by navigating here before the target. */
  homeUrl?: string;
  /** Wait for this selector after navigation, then proceed regardless. */
  readySelector?: string;
  readyTimeoutMs?: number;
}

/** Render one URL through a browser. Injectable so tools and tests can avoid Chromium. */
export type BrowserRenderer = (url: string, options?: RenderPageOptions) => Promise<RenderedPage>;

/** Default desktop viewport for rendered pages. */
export const BROWSER_VIEWPORT = { width: 1365, height: 768, deviceScaleFactor: 1 } as const;
/** The subset of a Puppeteer request the interception handler uses. */
export interface InterceptableRequest {
  url(): string;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
  /** True for top-level and iframe navigations; used for the asynchronous DNS guard. */
  isNavigationRequest?(): boolean;
  /** Browser-reported resource type, used by subresource blocking. */
  resourceType?(): string;
  /** Frame that made the request, for the third-party decision. */
  frame?(): { url(): string } | null;
}

/** The subset of a Puppeteer page the renderer uses. */
export interface BrowserPage {
  goto(
    url: string,
    options?: { waitUntil?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  url(): string;
  close(): Promise<void>;
  setRequestInterception(value: boolean): Promise<void>;
  setViewport?(viewport: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
  }): Promise<void>;
  setUserAgent?(userAgent: string): Promise<void>;
  on(event: "request", handler: (request: InterceptableRequest) => void): void;
  waitForSelector?(
    selector: string,
    options: { timeout: number; signal?: AbortSignal },
  ): Promise<unknown>;
}

export function isBlockedRequestUrl(url: string, allowPrivateHosts: boolean): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  if (allowPrivateHosts) return false;
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  return isBlockedHostname(host) || isPrivateAddress(host);
}

export interface SystemBrowserCandidateOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  which?: (name: string) => string | undefined;
}

function isExecutableFile(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultWhich(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const extensions =
    platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

/** Candidate Chrome/Chromium/Edge executables for a platform, in preference order. */
export function systemBrowserCandidates(options: SystemBrowserCandidateOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const which = options.which ?? ((name: string) => defaultWhich(name, env, platform));
  const candidates: string[] = [];

  if (platform === "darwin") {
    for (const root of ["/Applications", join(home, "Applications")]) {
      candidates.push(
        join(root, "Google Chrome.app/Contents/MacOS/Google Chrome"),
        join(root, "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"),
        join(root, "Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev"),
        join(root, "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
        join(root, "Chromium.app/Contents/MacOS/Chromium"),
        join(root, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
      );
    }
    return candidates;
  }

  if (platform === "linux") {
    for (const name of [
      "google-chrome-stable",
      "google-chrome",
      "chromium",
      "chromium-browser",
      "chrome",
      "microsoft-edge-stable",
      "microsoft-edge",
    ]) {
      const found = which(name);
      if (found) candidates.push(found);
    }
    candidates.push(
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/microsoft-edge",
      join(home, ".nix-profile/bin/chromium"),
      "/run/current-system/sw/bin/chromium",
    );
    return candidates;
  }

  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = env.LOCALAPPDATA ?? join(home, "AppData\\Local");
    candidates.push(
      join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
      join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
      join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
      join(programFiles, "Chromium\\Application\\chrome.exe"),
      join(localAppData, "Chromium\\Application\\chrome.exe"),
      join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
    );
  }

  return candidates;
}

/** Run `<binary> --version` and accept only a Chromium/Edge fingerprint. */
export function probeChromiumExecutable(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { timeout: 5_000, killSignal: "SIGKILL" }, (error, stdout) => {
      if (error) return resolve(false);
      resolve(/Chrom|Edg/i.test(stdout));
    });
  });
}

export interface BrowserDetectionOptions extends SystemBrowserCandidateOptions {
  isExecutable?: (path: string) => boolean;
  probe?: (path: string) => Promise<boolean>;
}

/** Detect an installed Chrome/Chromium/Edge, probing candidates on Linux. */
export async function detectSystemBrowser(
  options: BrowserDetectionOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? ((path: string) => isExecutableFile(path, platform));
  const probe =
    options.probe ?? (platform === "linux" ? probeChromiumExecutable : async () => true);
  const seen = new Set<string>();
  for (const candidate of systemBrowserCandidates(options)) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (!isExecutable(candidate)) continue;
    if (!(await probe(candidate))) continue;
    return candidate;
  }
  return undefined;
}

export interface ResolveBrowserOptions {
  executablePath?: string;
  env?: NodeJS.ProcessEnv;
  /** Check the configured path before `PUPPETEER_EXECUTABLE_PATH`. */
  preferConfigured?: boolean;
  detection?: BrowserDetectionOptions;
  detect?: (options?: BrowserDetectionOptions) => Promise<string | undefined>;
}

const detectionCache = new WeakMap<
  NonNullable<ResolveBrowserOptions["detect"]>,
  Promise<string | undefined>
>();
let defaultDetection: Promise<string | undefined> | undefined;

/**
 * Resolve the browser binary in precedence order: `PUPPETEER_EXECUTABLE_PATH`,
 * then `browser.executablePath`, then a detected system browser. With
 * `preferConfigured`, the configured path wins over the environment. Returns
 * undefined when none resolves, leaving the feature absent.
 */
export async function resolveBrowserExecutable(
  options: ResolveBrowserOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const configured = options.executablePath?.trim();
  if (options.preferConfigured && configured) return configured;
  const fromEnv = env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (configured) return configured;
  if (options.detection) {
    return (options.detect ?? detectSystemBrowser)(options.detection);
  }
  if (options.detect) {
    const detect = options.detect;
    let cached = detectionCache.get(detect);
    if (!cached) {
      cached = detect(undefined);
      detectionCache.set(detect, cached);
    }
    return cached;
  }
  // Detection is a stable process-wide fact; run it once until the shared
  // browser is torn down. Caching a `detect` function by identity keeps test
  // injections isolated from the default cache.
  defaultDetection ??= detectSystemBrowser();
  return defaultDetection;
}

/** Forget the cached default detection result. */
function resetBrowserDetection(): void {
  defaultDetection = undefined;
}

export interface CreateBrowserRendererOptions {
  /** Agent directory holding browser profiles and instance records. */
  agentDir: string;
  /** Working directory for resolving relative profile paths. */
  cwd: string;
  config: BrowserConfig;
  /** Shared runtime settings: profile, attach, isolation, page cap, launch mode. */
  runtimeConfig: RuntimeConfig;
  /** Pacing budget and learned host state for navigations. */
  politeness?: Politeness;
  /** Subresource blocking for rendered pages; defaults to the standard third-party set. */
  blocking?: BlockingConfig;
  /** Per-host overrides used for `hosts.<host>.allow`. */
  hosts?: Record<string, HostPolicy>;
  /** DNS resolver for the SSRF guard; injectable for tests. */
  resolve?: ResolveHost;
  executablePath?: string;
  detection?: BrowserDetectionOptions;
  /** Runtime override, primarily for tests. */
  runtime?: BrowserRuntime;
  /** Process and connection overrides, primarily for tests. */
  ensure?: BrowserRuntimeOptions["ensure"];
  connect?: BrowserRuntimeOptions["connect"];
  closeBrowser?: BrowserRuntimeOptions["closeBrowser"];
}

export { browserRuntimeFor, cookiesForUrl, createBrowserRenderer } from "./browser/render";

/** Close and forget every shared browser runtime this process opened. */
export async function disposeSharedBrowser(): Promise<void> {
  const { resetSharedBrowserRuntimes, sharedRuntimeEntries } = await import("./browser/runtime");
  const entries = sharedRuntimeEntries();
  resetSharedBrowserRuntimes();
  resetBrowserDetection();
  await Promise.all(entries.map(([, runtime]) => runtime.releaseAll().catch(() => undefined)));
}
