// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { BrowserConfig } from "./config";
import { checkUrlAllowed, isBlockedHostname, isPrivateAddress } from "./security";

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
/** Default desktop Chrome user agent for rendered pages. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PAGE_CLOSE_TIMEOUT_MS = 5_000;
const LAUNCH_PROTOCOL_TIMEOUT_MS = 60_000;

/** The subset of a Puppeteer request the interception handler uses. */
export interface InterceptableRequest {
  url(): string;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
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

export interface BrowserProcessLike {
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** The subset of a Puppeteer browser the session uses. */
export interface BrowserInstance {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
  process?(): BrowserProcessLike | null;
  on(event: "disconnected", handler: () => void): void;
}

export interface BrowserLaunchOptions {
  executablePath: string;
  noSandbox: boolean;
  headless: boolean;
  userDataDir?: string;
  args: string[];
}

export type BrowserLauncher = (options: BrowserLaunchOptions) => Promise<BrowserInstance>;

/**
 * Validate a request URL for interception: only `http`/`https`, and unless
 * private hosts are allowed, no local alias, metadata service, or literal
 * private address. Hostnames are not resolved here; the initial navigation is
 * guard-checked separately.
 */
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
  detection?: BrowserDetectionOptions;
  detect?: (options?: BrowserDetectionOptions) => Promise<string | undefined>;
}

/**
 * Resolve the browser binary in precedence order: `PUPPETEER_EXECUTABLE_PATH`,
 * then `browser.executablePath`, then a detected system browser. Returns
 * undefined when none resolves, leaving the feature absent.
 */
export async function resolveBrowserExecutable(
  options: ResolveBrowserOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const fromEnv = env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (fromEnv) return fromEnv;
  const configured = options.executablePath?.trim();
  if (configured) return configured;
  const detect = options.detect ?? detectSystemBrowser;
  return detect(options.detection);
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error("Aborted");
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isNavigationTimeout(error: unknown): boolean {
  return error instanceof Error && /navigation timeout|timeout/i.test(error.message);
}

/** Launch a real headless Chromium through `puppeteer-core`. */
export async function defaultBrowserLauncher(
  options: BrowserLaunchOptions,
): Promise<BrowserInstance> {
  const { launch } = await import("puppeteer-core");
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    ...options.args,
  ];
  if (options.noSandbox) args.push("--no-sandbox", "--disable-setuid-sandbox");
  const browser = await launch({
    executablePath: options.executablePath,
    headless: options.headless,
    userDataDir: options.userDataDir,
    args,
    ignoreDefaultArgs: ["--enable-automation"],
    protocolTimeout: LAUNCH_PROTOCOL_TIMEOUT_MS,
  });
  return browser as unknown as BrowserInstance;
}

export interface BrowserSessionOptions {
  executablePath: string;
  userDataDir?: string;
  noSandbox?: boolean;
  allowPrivateHosts?: boolean;
  defaultTimeoutMs?: number;
  idleCloseMs?: number;
  maxPages?: number;
  launch?: BrowserLauncher;
}

/**
 * One process-wide headless Chromium, launched lazily, reused across calls,
 * capped by `maxPages`, idle-closed, and disposed on demand. Pages are opened
 * per render and closed afterward; the browser process is the shared resource.
 */
export class BrowserSession {
  private readonly executablePath: string;
  private readonly userDataDir: string | undefined;
  private readonly noSandbox: boolean;
  private readonly allowPrivateHosts: boolean;
  private readonly defaultTimeoutMs: number;
  private readonly idleCloseMs: number;
  private readonly maxPages: number;
  private readonly launch: BrowserLauncher;

  private browser: BrowserInstance | undefined;
  private launchPromise: Promise<BrowserInstance> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private activePages = 0;
  private availableSlots: number;
  private readonly slotWaiters: Array<() => void> = [];
  private disposed = false;

  constructor(options: BrowserSessionOptions) {
    this.executablePath = options.executablePath;
    this.userDataDir = options.userDataDir;
    this.noSandbox = options.noSandbox ?? false;
    this.allowPrivateHosts = options.allowPrivateHosts ?? false;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 20_000;
    this.idleCloseMs = options.idleCloseMs ?? 0;
    this.maxPages = Math.max(1, options.maxPages ?? 1);
    this.availableSlots = this.maxPages;
    this.launch = options.launch ?? defaultBrowserLauncher;
  }

  /** Render a URL and return its final HTML, status, and URL. */
  async render(url: string, options: RenderPageOptions = {}): Promise<RenderedPage> {
    if (this.disposed) throw new Error("Browser session has been disposed");
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

    if (!this.allowPrivateHosts) {
      const guard = await checkUrlAllowed(url, { allowPrivateHosts: false });
      if (!guard.allowed) throw new Error(`Blocked URL: ${guard.reason ?? url}`);
    }

    await this.acquireSlot(signal);
    this.activePages++;
    this.cancelIdleClose();
    let page: BrowserPage | undefined;
    try {
      const browser = await raceWithSignal(this.getBrowser(), signal);
      page = await raceWithSignal(browser.newPage(), signal);
      await this.configurePage(page);
      if (options.homeUrl) {
        await raceWithSignal(
          page.goto(options.homeUrl, {
            waitUntil: "domcontentloaded",
            timeout: timeoutMs,
            signal,
          }),
          signal,
        );
      }

      let status = 200;
      try {
        const response = await raceWithSignal(
          page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs, signal }),
          signal,
        );
        status = response?.status() ?? 200;
      } catch (error) {
        // A navigation timeout can still leave a rendered DOM; capture it below.
        if (signal.aborted) throw error;
        if (!isNavigationTimeout(error)) throw error;
      }

      if (options.readySelector && page.waitForSelector) {
        await raceWithSignal(
          page
            .waitForSelector(options.readySelector, {
              timeout: options.readyTimeoutMs ?? 10_000,
              signal,
            })
            .catch(() => undefined),
          signal,
        );
      }

      const html = await raceWithSignal(page.content(), signal);
      return { html, status, finalUrl: page.url() };
    } finally {
      if (page) await settleWithin(page.close(), PAGE_CLOSE_TIMEOUT_MS);
      this.activePages--;
      this.releaseSlot();
      if (this.activePages === 0) this.scheduleIdleClose();
    }
  }

  /** Close the shared browser, if launched. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelIdleClose();
    const browser = this.browser;
    this.browser = undefined;
    this.launchPromise = undefined;
    if (browser) await settleWithin(browser.close(), PAGE_CLOSE_TIMEOUT_MS);
  }

  /** Synchronously kill the browser process, for process-exit cleanup. */
  disposeSync(): void {
    this.disposed = true;
    this.cancelIdleClose();
    const browser = this.browser;
    this.browser = undefined;
    this.launchPromise = undefined;
    try {
      browser?.process?.()?.kill("SIGKILL");
    } catch {
      // Best effort: the process may already be gone.
    }
  }

  private async configurePage(page: BrowserPage): Promise<void> {
    if (page.setViewport) await page.setViewport({ ...BROWSER_VIEWPORT });
    if (page.setUserAgent) await page.setUserAgent(BROWSER_USER_AGENT);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      void this.handleRequest(request);
    });
  }

  private async handleRequest(request: InterceptableRequest): Promise<void> {
    try {
      if (isBlockedRequestUrl(request.url(), this.allowPrivateHosts)) {
        await request.abort();
      } else {
        await request.continue();
      }
    } catch {
      // The request may already be settled after a navigation teardown.
    }
  }

  private async getBrowser(): Promise<BrowserInstance> {
    if (this.browser) return this.browser;
    if (!this.launchPromise) {
      this.launchPromise = this.launch({
        executablePath: this.executablePath,
        noSandbox: this.noSandbox,
        headless: true,
        userDataDir: this.userDataDir,
        args: [],
      });
    }
    try {
      const browser = await this.launchPromise;
      this.browser = browser;
      browser.on("disconnected", () => {
        if (this.browser === browser) this.browser = undefined;
      });
      return browser;
    } catch (error) {
      this.launchPromise = undefined;
      throw error;
    }
  }

  private async acquireSlot(signal: AbortSignal): Promise<void> {
    if (this.availableSlots > 0) {
      this.availableSlots--;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        const index = this.slotWaiters.indexOf(waiter);
        if (index >= 0) this.slotWaiters.splice(index, 1);
      };
      const waiter = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(abortError(signal));
      };
      this.slotWaiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private releaseSlot(): void {
    const next = this.slotWaiters.shift();
    if (next) next();
    else this.availableSlots++;
  }

  private scheduleIdleClose(): void {
    if (this.idleCloseMs <= 0 || this.disposed) return;
    this.cancelIdleClose();
    this.idleTimer = setTimeout(() => {
      void this.dispose();
    }, this.idleCloseMs);
    this.idleTimer.unref?.();
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}

let sharedSession: BrowserSession | undefined;
let exitHandlerRegistered = false;

function registerExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.once("exit", () => {
    const session = sharedSession;
    sharedSession = undefined;
    session?.disposeSync();
  });
}

export interface CreateBrowserRendererOptions {
  config: BrowserConfig;
  executablePath?: string;
  detection?: BrowserDetectionOptions;
  launch?: BrowserLauncher;
  /** Use a specific session instead of the process-wide one; primarily for tests. */
  session?: BrowserSession;
}

/**
 * Build a renderer when a browser resolves and `browser.enabled` is true.
 * Returns undefined when the feature is off or no browser is present, so the
 * tools behave exactly as before.
 */
export async function createBrowserRenderer(
  options: CreateBrowserRendererOptions,
): Promise<BrowserRenderer | undefined> {
  if (!options.config.enabled) return undefined;
  const executablePath =
    options.executablePath ??
    (await resolveBrowserExecutable({
      executablePath: options.config.executablePath,
      detection: options.detection,
    }));
  if (!executablePath) return undefined;
  const session =
    options.session ??
    getSharedBrowserSession({
      executablePath,
      userDataDir: options.config.userDataDir,
      noSandbox: options.config.noSandbox,
      allowPrivateHosts: options.config.allowPrivateHosts,
      defaultTimeoutMs: options.config.timeoutSeconds * 1000,
      idleCloseMs: options.config.idleCloseSeconds * 1000,
      maxPages: options.config.maxPages,
      launch: options.launch,
    });
  return (url, renderOptions) => session.render(url, renderOptions);
}

function getSharedBrowserSession(options: BrowserSessionOptions): BrowserSession {
  if (!sharedSession) {
    sharedSession = new BrowserSession(options);
    registerExitHandler();
  }
  return sharedSession;
}

/** Close and forget the process-wide browser session. */
export async function disposeSharedBrowser(): Promise<void> {
  const session = sharedSession;
  sharedSession = undefined;
  if (session) await session.dispose();
}

/** The process-wide browser session, when one has been created. */
export function sharedBrowserSession(): BrowserSession | undefined {
  return sharedSession;
}
