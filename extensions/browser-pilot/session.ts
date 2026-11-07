import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  Browser,
  CDPSession,
  Dialog,
  Frame,
  HTTPRequest,
  HTTPResponse,
  Page,
} from "puppeteer-core";
import { expandTilde } from "../../lib/logging";
import { buildHar } from "./har";
import { matchesRoute } from "./route";
import {
  closeChrome,
  connectChrome,
  disposeChromeSync,
  ensureChrome,
  instanceRecordPath,
  resolveProfile,
} from "./launcher";
import { detectChallenge } from "./challenge";
import { checkNavigationAllowed } from "./security";
import type {
  BrowserPilotConfig,
  ChallengeInfo,
  ChromeInstance,
  ConsoleEntry,
  DialogInfo,
  DownloadInfo,
  EmulationState,
  ManagedTab,
  NetworkEntry,
  ProfileInfo,
  RouteRule,
  SessionRecord,
  TabInfo,
} from "./types";
import { BrowserPilotError } from "./types";

const SESSION_SCHEMA = 1;
const TAB_IDLE_CLEANUP_MS = 5 * 60_000;
const MAX_HAR_BODY_BYTES = 1024 * 1024;

type NetworkProfileName = "offline" | "slow3g" | "fast3g" | "slow4g" | "fast4g";

const NETWORK_PROFILES: Record<
  NetworkProfileName,
  { latency: number; download: number; upload: number }
> = {
  offline: { latency: 0, download: 0, upload: 0 },
  slow3g: { latency: 2000, download: 50_000, upload: 20_000 },
  fast3g: { latency: 150, download: 180_000, upload: 80_000 },
  slow4g: { latency: 100, download: 500_000, upload: 250_000 },
  fast4g: { latency: 20, download: 4_000_000, upload: 1_000_000 },
};

const STEALTH_SCRIPT = `
Object.defineProperty(navigator, "webdriver", { get: () => false });
if (!navigator.languages || navigator.languages.length === 0) {
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
}
`;

export interface NavigateResult {
  tab: TabInfo;
  status: number;
  url: string;
  title: string;
  challenge?: ChallengeInfo;
  note?: string;
}

/** One pi session's Chrome process, tabs, refs, and captured activity. */
export class BrowserPilotSession {
  readonly sessionId: string;
  readonly agentDir: string;
  readonly cwd: string;
  config: BrowserPilotConfig;

  profile?: ProfileInfo;
  instance?: ChromeInstance;
  browser?: Browser;
  tabs = new Map<number, ManagedTab>();
  current?: number;
  nextHandle = 1;
  refs = new Map<string, { selector: string; snapshot: number; frame?: Frame }>();
  snapshotCount = 0;
  dialogPolicy: "dismiss" | "accept" | "manual" = "dismiss";
  pendingDialog?: DialogInfo;
  challenge?: ChallengeInfo;
  downloads: DownloadInfo[] = [];
  routeRules: RouteRule[] = [];
  emulation: EmulationState = {};

  private pendingDialogHandle?: Dialog;
  private requestEntries = new WeakMap<HTTPRequest, NetworkEntry>();
  private networkSequence = 0;
  private routeSequence = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private downloadClient?: CDPSession;
  private harRecording = false;
  private traceClient?: CDPSession;
  private traceChunks: string[] = [];
  private traceTab?: number;

  constructor(options: {
    sessionId: string;
    agentDir: string;
    cwd: string;
    config: BrowserPilotConfig;
  }) {
    this.sessionId = options.sessionId;
    this.agentDir = options.agentDir;
    this.cwd = options.cwd;
    this.config = options.config;
  }

  /** True once the session has been closed; a closed session cannot act. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Ensure a connected browser, launching or reconnecting as needed. */
  async ensure(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new BrowserPilotError("This browser-pilot session is closed.");
    if (this.browser?.connected) return;

    if (this.browser) {
      try {
        if (!this.instance?.external) await this.browser.close();
      } catch {
        // The browser may already be gone.
      }
      this.browser = undefined;
    }

    if (this.instance?.external) {
      try {
        this.browser = await connectChrome(this.instance);
      } catch (error) {
        throw new BrowserPilotError(
          `Could not reconnect to ${this.instance.wsEndpoint}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "Reconnect with connect, or close the browser and launch a new one.",
        );
      }
      this.browser.on("disconnected", () => {
        this.browser = undefined;
        this.downloadClient = undefined;
      });
      await this.restoreExternal();
      await this.configureDownloads();
      return;
    }

    const { instance, profile } = await ensureChrome({
      config: this.config,
      sessionId: this.sessionId,
      agentDir: this.agentDir,
      cwd: this.cwd,
      signal,
    });
    this.instance = instance;
    this.profile = profile;
    try {
      this.browser = await connectChrome(instance);
    } catch (error) {
      throw new BrowserPilotError(
        `Could not connect to Chrome on port ${instance.port}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "Run status to inspect the instance, or close the browser and try again.",
      );
    }
    this.browser.on("disconnected", () => {
      this.browser = undefined;
      this.downloadClient = undefined;
    });
    await this.restoreOrCreate(signal);
    await this.configureDownloads();
  }

  /** Attach to an existing Chrome DevTools endpoint instead of launching Chrome. */
  async connectExternal(endpoint: string): Promise<ChromeInstance> {
    if (this.disposed) throw new BrowserPilotError("This browser-pilot session is closed.");
    if (this.browser?.connected || this.instance) {
      throw new BrowserPilotError(
        "This session is already connected to a browser.",
        'Run {action:"close", target:"browser"} first, then connect to another endpoint.',
      );
    }
    const wsEndpoint = await resolveDevToolsEndpoint(endpoint);
    let port = 0;
    try {
      const parsed = new URL(wsEndpoint);
      port = parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === "wss:" ? 443 : 80;
    } catch {
      throw new BrowserPilotError(`Invalid DevTools endpoint: ${endpoint}`);
    }
    const instance: ChromeInstance = {
      pid: 0,
      port,
      wsEndpoint,
      userDataDir: "",
      executablePath: "",
      startedAt: new Date().toISOString(),
      ownerSessionId: this.sessionId,
      external: true,
    };
    try {
      this.browser = await connectChrome(instance);
    } catch (error) {
      throw new BrowserPilotError(
        `Could not attach to ${wsEndpoint}: ${error instanceof Error ? error.message : String(error)}`,
        "Check that Chrome is running with --remote-debugging-port and that the endpoint is reachable.",
      );
    }
    this.instance = instance;
    this.profile = {
      key: `external-${port}`,
      userDataDir: "",
      label: endpoint,
      persistent: true,
    };
    this.browser.on("disconnected", () => {
      this.browser = undefined;
    });
    await this.restoreExternal();
    await this.configureDownloads();
    this.persist();
    return instance;
  }

  /** Attach pages already open in an external browser. */
  private async restoreExternal(): Promise<void> {
    if (!this.browser?.connected) return;
    const pages = await this.browser.pages();
    for (const page of pages) {
      if (page.url().startsWith("devtools://")) continue;
      const targetId = targetIdOf(page);
      if ([...this.tabs.values()].some((tab) => tab.targetId === targetId)) continue;
      await this.attachPage(page, false, undefined, true);
    }
    if (this.current === undefined) {
      this.current = [...this.tabs.values()].find((tab) => !tab.page.isClosed())?.handle;
    }
    if (this.tabs.size === 0) {
      const page = await this.browser.newPage();
      const tab = await this.attachPage(page, true);
      this.current = tab.handle;
    }
    this.refs.clear();
    this.snapshotCount++;
    this.persist();
  }

  /** Configure browser-level download capture into the downloads directory. */
  private async configureDownloads(): Promise<void> {
    if (!this.browser?.connected || this.downloadClient) return;
    try {
      const directory = this.downloadsDir();
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const client = await this.browser.target().createCDPSession();
      await client.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: directory,
        eventsEnabled: true,
      });
      client.on(
        "Browser.downloadWillBegin",
        (event: { guid?: string; url?: string; suggestedFilename?: string }) => {
          if (!event.guid) return;
          const filename = safeFilename(event.suggestedFilename ?? event.guid);
          this.downloads.push({
            id: event.guid,
            url: event.url ?? "",
            suggestedFilename: filename,
            state: "inProgress",
            receivedBytes: 0,
            totalBytes: 0,
            path: join(directory, filename),
            startedAt: new Date().toISOString(),
          });
        },
      );
      client.on(
        "Browser.downloadProgress",
        (event: {
          guid?: string;
          state?: "inProgress" | "completed" | "canceled";
          receivedBytes?: number;
          totalBytes?: number;
        }) => {
          const download = this.downloads.find((item) => item.id === event.guid);
          if (!download) return;
          if (event.state) download.state = event.state;
          if (event.receivedBytes !== undefined) download.receivedBytes = event.receivedBytes;
          if (event.totalBytes !== undefined) download.totalBytes = event.totalBytes;
          if (download.state !== "inProgress" && !download.completedAt) {
            download.completedAt = new Date().toISOString();
          }
        },
      );
      this.downloadClient = client;
    } catch {
      // Download capture is optional; the browser may not support the command.
    }
  }

  /** Directory where downloads are saved. */
  downloadsDir(): string {
    return this.resolveDir(
      this.config.downloadsDir,
      join(this.agentDir, "browser-pilot", "downloads"),
    );
  }

  /** Directory for PDF, HAR, and trace exports. */
  exportsDir(): string {
    return this.resolveDir(this.config.exportsDir, join(this.agentDir, "browser-pilot", "exports"));
  }

  private resolveDir(value: string | undefined, fallback: string): string {
    if (!value) return fallback;
    const expanded = expandTilde(value);
    return isAbsolute(expanded) ? expanded : resolve(this.cwd, expanded);
  }

  /** Downloads matching a filename or URL substring, newest last. */
  listDownloads(filter?: string): DownloadInfo[] {
    return this.downloads.filter(
      (download) =>
        !filter || download.suggestedFilename.includes(filter) || download.url.includes(filter),
    );
  }

  /** Wait for the newest matching download to finish. */
  async waitForDownload(
    timeoutMs: number,
    filter?: string,
    signal?: AbortSignal,
  ): Promise<DownloadInfo> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const download = this.listDownloads(filter).at(-1);
      if (download && download.state !== "inProgress") return download;
      await sleep(100);
    }
    throw new BrowserPilotError(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for a download.`,
      'Check download {op:"list"}; the browser may have blocked or canceled the file.',
    );
  }

  /** Clear the download history, not the files on disk. */
  clearDownloads(): number {
    const count = this.downloads.length;
    this.downloads.length = 0;
    return count;
  }

  /** Start recording a HAR. Existing network buffers are cleared. */
  startHar(): void {
    this.harRecording = true;
    for (const tab of this.tabs.values()) tab.network.length = 0;
  }

  /** True while HAR capture is active. */
  get isRecordingHar(): boolean {
    return this.harRecording;
  }

  /** Clear captured network entries used by HAR export. */
  clearHar(): number {
    let count = 0;
    for (const tab of this.tabs.values()) {
      count += tab.network.length;
      tab.network.length = 0;
    }
    return count;
  }

  /** Stop recording and return a HAR document built from captured entries. */
  async stopHar(): Promise<{ har: Record<string, unknown>; entries: number }> {
    this.harRecording = false;
    const entries = [...this.tabs.values()].flatMap((tab) => tab.network);
    const har = buildHar(entries, { tabs: await this.listTabs() });
    return { har, entries: entries.length };
  }

  /** Add a request interception rule and enable interception on every tab. */
  async addRouteRule(rule: Omit<RouteRule, "id">): Promise<RouteRule> {
    const created: RouteRule = { ...rule, id: `r${++this.routeSequence}` };
    this.routeRules.push(created);
    await this.setInterception(true);
    return created;
  }

  /** Remove one rule by id, disabling interception when no rules remain. */
  async removeRouteRule(id: string): Promise<boolean> {
    const index = this.routeRules.findIndex((rule) => rule.id === id);
    if (index === -1) return false;
    this.routeRules.splice(index, 1);
    if (this.routeRules.length === 0) await this.setInterception(false);
    return true;
  }

  /** Remove all rules and disable interception. */
  async clearRouteRules(): Promise<number> {
    const count = this.routeRules.length;
    this.routeRules.length = 0;
    await this.setInterception(false);
    return count;
  }

  private async setInterception(enabled: boolean): Promise<void> {
    for (const tab of this.tabs.values()) {
      if (tab.page.isClosed()) continue;
      await tab.page.setRequestInterception(enabled).catch(() => undefined);
    }
  }

  private async applyRouteRule(tab: ManagedTab, request: HTTPRequest): Promise<void> {
    if (request.isInterceptResolutionHandled()) return;
    let resourceType: string | undefined;
    try {
      resourceType = request.resourceType();
    } catch {
      resourceType = undefined;
    }
    const rule = this.routeRules.find((candidate) =>
      matchesRoute(candidate, request.url(), resourceType),
    );
    try {
      if (!rule) {
        await request.continue();
        return;
      }
      if (rule.action === "abort") {
        await request.abort("blockedbyclient");
      } else if (rule.action === "delay") {
        await sleep(rule.delayMs ?? 0);
        await request.continue();
      } else if (rule.action === "fulfill") {
        await request.respond({
          status: rule.status ?? 200,
          headers: rule.headers,
          contentType: rule.contentType ?? "text/plain",
          body: rule.body ?? "",
        });
      } else {
        await request.continue();
      }
    } catch {
      // A navigation or browser shutdown can close the request first.
    }
    tab.lastUsed = Date.now();
  }

  /** Start a Chrome trace for one tab. */
  async startTrace(tabHandle?: number): Promise<TabInfo> {
    if (this.traceClient) {
      throw new BrowserPilotError(
        "A trace is already recording.",
        'Stop it with {action:"trace", op:"stop"}.',
      );
    }
    const tab = await this.ensureTab(tabHandle);
    const client = await tab.page.createCDPSession();
    this.traceChunks = [];
    this.traceTab = tab.handle;
    this.traceClient = client;
    client.on("Tracing.dataCollected", (event: { value?: string[] }) => {
      if (Array.isArray(event.value)) this.traceChunks.push(...event.value);
    });
    await client.send("Tracing.start", {
      categories:
        "devtools.timeline,disabled-by-default-devtools.timeline,loading,blink.user_timing,v8",
      transferMode: "ReportEvents",
    });
    const infos = await this.listTabs();
    return infos.find((info) => info.handle === tab.handle)!;
  }

  /** Stop the active trace and return its JSON document. */
  async stopTrace(): Promise<{ trace: unknown; events: number; tab?: number }> {
    const client = this.traceClient;
    if (!client) {
      throw new BrowserPilotError(
        "No trace is recording.",
        'Start one with {action:"trace", op:"start"}.',
      );
    }
    this.traceClient = undefined;
    const completed = new Promise<void>((resolvePromise) => {
      client.once("Tracing.tracingComplete", () => resolvePromise());
    });
    await client.send("Tracing.end");
    await Promise.race([completed, sleep(10_000)]);
    await client.detach().catch(() => undefined);
    const events = this.traceChunks.map((chunk) => {
      try {
        return JSON.parse(chunk) as unknown;
      } catch {
        return { name: "unparsed", args: { raw: chunk } };
      }
    });
    this.traceChunks = [];
    const tab = this.traceTab;
    this.traceTab = undefined;
    return { trace: { traceEvents: events }, events: events.length, tab };
  }

  /** Apply the session's emulation overrides to one page. */
  async applyEmulation(page: Page): Promise<void> {
    const state = this.emulation;
    const viewport = state.viewport ?? {
      width: this.config.viewport.width,
      height: this.config.viewport.height,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    };
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      isMobile: viewport.isMobile ?? false,
      hasTouch: viewport.hasTouch ?? false,
    });
    await page.setUserAgent(state.userAgent ?? this.userAgent());
    const client = await page.createCDPSession();
    try {
      await client.send("Emulation.setEmulatedMedia", {
        features: [
          ...(state.colorScheme
            ? [{ name: "prefers-color-scheme", value: state.colorScheme }]
            : []),
          ...(state.reducedMotion
            ? [{ name: "prefers-reduced-motion", value: state.reducedMotion }]
            : []),
        ],
      });
      await client.send("Emulation.setCPUThrottlingRate", {
        rate: state.cpuThrottle ?? 1,
      });
      const locale = state.locale ?? this.config.locale;
      const timezone = state.timezone ?? this.config.timezone;
      if (locale) {
        await client.send("Emulation.setLocaleOverride", { locale });
      } else {
        await client.send("Emulation.setLocaleOverride", { locale: "" }).catch(() => undefined);
      }
      if (timezone) {
        await client.send("Emulation.setTimezoneOverride", { timezoneId: timezone });
      } else {
        await client
          .send("Emulation.setTimezoneOverride", { timezoneId: "" })
          .catch(() => undefined);
      }
    } finally {
      await client.detach().catch(() => undefined);
    }
    if (state.network !== undefined) {
      await page.emulateNetworkConditions(state.network).catch(() => undefined);
    }
    if (state.geolocation) {
      await page.setGeolocation(state.geolocation).catch(() => undefined);
    } else {
      const geoClient = await page.createCDPSession();
      await geoClient
        .send("Emulation.clearGeolocationOverride")
        .catch(() => undefined)
        .finally(() => geoClient.detach().catch(() => undefined));
    }
  }

  /** Replace the emulation state and apply it to the current tab. */
  async setEmulation(tabHandle: number | undefined, state: EmulationState): Promise<TabInfo> {
    const tab = await this.ensureTab(tabHandle);
    this.emulation = state;
    await this.applyEmulation(tab.page);
    const infos = await this.listTabs();
    return infos.find((info) => info.handle === tab.handle)!;
  }

  /** Build the network emulation condition for a named profile. */
  networkProfile(name: NetworkProfileName) {
    return NETWORK_PROFILES[name];
  }

  /** Return a usable tab, creating a blank one when necessary. */
  async ensureTab(tab?: number): Promise<ManagedTab> {
    await this.ensure();
    if (tab !== undefined) {
      const found = this.tabs.get(tab);
      if (!found || found.page.isClosed()) {
        throw new BrowserPilotError(
          `Tab ${tab} is not open.`,
          'Run tabs {op:"list"} to see open tabs.',
        );
      }
      return found;
    }
    if (this.current !== undefined) {
      const current = this.tabs.get(this.current);
      if (current && !current.page.isClosed()) return current;
    }
    const first = [...this.tabs.values()].find((candidate) => !candidate.page.isClosed());
    if (first) {
      this.current = first.handle;
      return first;
    }
    return this.newTab();
  }

  /** Open a new tab, enforcing the tab cap and ownership rules. */
  async newTab(url?: string, signal?: AbortSignal): Promise<ManagedTab> {
    await this.ensure();
    const openTabs = [...this.tabs.values()].filter((tab) => !tab.page.isClosed());
    if (openTabs.length >= this.config.maxTabs) {
      if (this.config.tabOverflow === "close-lru") {
        const victim = openTabs
          .filter((tab) => tab.owned && tab.handle !== this.current)
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (victim) await this.closeTab(victim.handle);
        else throw this.tabLimitError(openTabs);
      } else if (this.config.tabOverflow === "reuse-blank") {
        const blank = openTabs.find(
          (tab) => tab.owned && tab.handle !== this.current && tab.page.url() === "about:blank",
        );
        if (blank) {
          this.current = blank.handle;
          blank.lastUsed = Date.now();
          await blank.page.bringToFront().catch(() => undefined);
          this.persist();
          return blank;
        }
        throw this.tabLimitError(openTabs);
      } else {
        throw this.tabLimitError(openTabs);
      }
    }

    const page = await this.browser!.newPage();
    const tab = await this.attachPage(page, true);
    this.current = tab.handle;
    tab.lastUsed = Date.now();
    await page.bringToFront().catch(() => undefined);
    if (url) {
      await this.navigate(url, undefined, undefined, undefined, signal);
    }
    this.persist();
    return tab;
  }

  private tabLimitError(openTabs: ManagedTab[]): BrowserPilotError {
    const list = openTabs
      .map((tab) => `  ${tab.handle}: ${tab.page.url() || "about:blank"}`)
      .join("\n");
    return new BrowserPilotError(
      `Tab limit reached (${this.config.maxTabs}). Open tabs:\n${list}`,
      `Close one with tabs {op:"close", tab:<n>}, or set maxTabs higher in browser-pilot.json.`,
    );
  }

  /** Attach listeners and configuration to a Puppeteer page. */
  async attachPage(
    page: Page,
    owned: boolean,
    handle?: number,
    configure = true,
  ): Promise<ManagedTab> {
    const targetId = targetIdOf(page);
    for (const existing of this.tabs.values()) {
      if (existing.targetId === targetId) {
        existing.page = page;
        return existing;
      }
    }
    const assigned = handle ?? this.nextHandle++;
    if (assigned >= this.nextHandle) this.nextHandle = assigned + 1;
    const tab: ManagedTab = {
      handle: assigned,
      targetId,
      page,
      owned,
      lastUsed: Date.now(),
      console: [],
      network: [],
    };
    this.tabs.set(assigned, tab);
    this.installListeners(tab);
    if (configure) await this.configurePage(page).catch(() => undefined);
    return tab;
  }

  private installListeners(tab: ManagedTab): void {
    const page = tab.page;
    page.on("console", (message) => {
      const location = message.location();
      this.pushConsole(tab, {
        timestamp: new Date().toISOString(),
        level: message.type(),
        text: message.text(),
        url: location.url,
        line: location.lineNumber,
      });
    });
    page.on("pageerror", (error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.pushConsole(tab, {
        timestamp: new Date().toISOString(),
        level: "error",
        text: normalized.message,
        stack: normalized.stack,
      });
    });
    page.on("request", (request) => {
      const entry: NetworkEntry = {
        id: String(++this.networkSequence),
        timestamp: new Date().toISOString(),
        method: request.method(),
        url: request.url(),
        resourceType: safeResourceType(request),
        startedAt: Date.now(),
      };
      if (this.harRecording) {
        entry.requestHeaders = request.headers();
        entry.postData = request.postData() ?? undefined;
      }
      this.requestEntries.set(request, entry);
      tab.network.push(entry);
      trim(tab.network, this.config.networkBuffer);
      if (this.routeRules.length > 0) void this.applyRouteRule(tab, request);
    });
    page.on("response", (response) => {
      const entry = this.requestEntries.get(response.request());
      if (!entry) return;
      entry.status = response.status();
      entry.statusText = response.statusText();
      entry.mimeType = headerValue(response, "content-type");
      entry.durationMs = Date.now() - entry.startedAt;
      if (this.harRecording) {
        entry.responseHeaders = response.headers();
        entry.timing = response.timing();
        const length = Number.parseInt(headerValue(response, "content-length") ?? "", 10);
        if (!Number.isFinite(length) || length <= MAX_HAR_BODY_BYTES) {
          void response
            .text()
            .then((body) => {
              entry.responseBody = body.slice(0, MAX_HAR_BODY_BYTES);
              entry.responseBodyTruncated = body.length > MAX_HAR_BODY_BYTES;
              entry.size = body.length;
            })
            .catch(() => undefined);
        }
      }
    });
    page.on("requestfailed", (request) => {
      const entry = this.requestEntries.get(request);
      if (!entry) return;
      entry.failed = request.failure()?.errorText ?? "request failed";
      entry.durationMs = Date.now() - entry.startedAt;
    });
    page.on("dialog", (dialog) => {
      void this.handleDialog(tab, dialog);
    });
    page.on("close", () => {
      this.tabs.delete(tab.handle);
      if (this.current === tab.handle) {
        this.current = [...this.tabs.values()].find(
          (candidate) => !candidate.page.isClosed(),
        )?.handle;
      }
      this.persist();
    });
    page.on("popup", (popup) => {
      if (!popup) return;
      void this.attachPage(popup, true)
        .then(async (opened) => {
          this.current = opened.handle;
          await popup.bringToFront().catch(() => undefined);
          this.persist();
        })
        .catch(() => undefined);
    });
  }

  private async handleDialog(tab: ManagedTab, dialog: Dialog): Promise<void> {
    tab.lastUsed = Date.now();
    this.pendingDialog = {
      type: dialog.type(),
      message: dialog.message(),
      defaultValue: dialog.defaultValue(),
      openedAt: new Date().toISOString(),
    };
    this.pendingDialogHandle = dialog;
    if (this.dialogPolicy === "manual") return;
    try {
      if (this.dialogPolicy === "accept") await dialog.accept();
      else await dialog.dismiss();
    } catch {
      // The page may have navigated while the dialog was open.
    } finally {
      this.pendingDialog = undefined;
      this.pendingDialogHandle = undefined;
    }
  }

  /** Accept or dismiss the pending dialog, or change the automatic policy. */
  async resolveDialog(options: {
    op: "accept" | "dismiss" | "policy";
    text?: string;
    policy?: "dismiss" | "accept" | "manual";
  }): Promise<{ dialog?: DialogInfo; policy: string }> {
    if (options.op === "policy") {
      if (options.policy) this.dialogPolicy = options.policy;
      return { policy: this.dialogPolicy };
    }
    const dialog = this.pendingDialogHandle;
    if (!dialog) {
      throw new BrowserPilotError(
        "No dialog is waiting.",
        "Dialogs are dismissed automatically unless dialogPolicy is manual.",
      );
    }
    if (options.op === "accept") await dialog.accept(options.text);
    else await dialog.dismiss();
    const info = this.pendingDialog;
    this.pendingDialog = undefined;
    this.pendingDialogHandle = undefined;
    return { dialog: info, policy: this.dialogPolicy };
  }

  private pushConsole(tab: ManagedTab, entry: ConsoleEntry): void {
    tab.console.push(entry);
    trim(tab.console, this.config.consoleBuffer);
  }

  private async configurePage(page: Page): Promise<void> {
    if (this.config.stealth !== "off") {
      await page.evaluateOnNewDocument(STEALTH_SCRIPT);
    }
    await this.applyEmulation(page);
    if (this.routeRules.length > 0) {
      await page.setRequestInterception(true).catch(() => undefined);
    }
  }

  private userAgent(): string {
    if (this.config.userAgent) return this.config.userAgent;
    const version = /Chrome\/([\d.]+)/.exec(this.instance?.chromeVersion ?? "")?.[1];
    const chromeVersion = version ?? "131.0.0.0";
    return `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }

  /** Reconnect to an existing tab set, or create a fresh tab. */
  private async restoreOrCreate(signal?: AbortSignal): Promise<void> {
    const record = this.readSessionRecord();
    const pages = await this.browser!.pages();
    if (record && this.instance && record.wsEndpoint === this.instance.wsEndpoint) {
      for (const saved of record.tabs) {
        const page = pages.find((candidate) => targetIdOf(candidate) === saved.targetId);
        if (!page) continue;
        await this.attachPage(page, saved.owned, saved.handle);
      }
      if (record.currentTab !== undefined && this.tabs.has(record.currentTab)) {
        this.current = record.currentTab;
      }
    }
    if (this.tabs.size === 0) {
      const lastUrl = record?.tabs.find((tab) => tab.handle === record.currentTab)?.url;
      if (this.config.restoreTabs && lastUrl && lastUrl !== "about:blank") {
        try {
          await this.newTab(lastUrl, signal);
        } catch {
          await this.newTab(undefined, signal);
        }
      } else {
        await this.newTab(undefined, signal);
      }
    }
    await this.closeStartupPages();
    this.refs.clear();
    this.snapshotCount++;
    this.persist();
  }

  private sessionRecordPath(): string {
    return join(this.agentDir, "browser-pilot", "sessions", `${sanitizeFile(this.sessionId)}.json`);
  }

  private readSessionRecord(): SessionRecord | undefined {
    const path = this.sessionRecordPath();
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SessionRecord>;
      if (
        parsed.schema !== SESSION_SCHEMA ||
        typeof parsed.sessionId !== "string" ||
        typeof parsed.wsEndpoint !== "string" ||
        !Array.isArray(parsed.tabs)
      ) {
        return undefined;
      }
      return parsed as SessionRecord;
    } catch {
      return undefined;
    }
  }

  /** Persist tab handles and URLs so a resumed session can reattach. */
  persist(): void {
    if (this.disposed) return;
    try {
      const record: SessionRecord = {
        schema: SESSION_SCHEMA,
        sessionId: this.sessionId,
        profileKey: this.profile?.key ?? "",
        wsEndpoint: this.instance?.wsEndpoint ?? "",
        currentTab: this.current,
        tabs: [...this.tabs.values()].map((tab) => ({
          handle: tab.handle,
          targetId: tab.targetId,
          url: tab.page.url(),
          owned: tab.owned,
        })),
      };
      const path = this.sessionRecordPath();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Session state is an optimization; never fail a tool call over it.
    }
  }

  /** Close Chrome's initial new-tab page after the agent's first tab exists. */
  private async closeStartupPages(): Promise<void> {
    if (!this.browser?.connected) return;
    const pages = await this.browser.pages();
    for (const page of pages) {
      const url = page.url();
      if (url.startsWith("chrome://new-tab-page") || url.startsWith("chrome://newtab")) {
        await page.close().catch(() => undefined);
      }
    }
  }

  /** Pick up tabs the user opened manually, without reconfiguring them. */
  private async syncTabs(): Promise<void> {
    if (!this.browser?.connected) return;
    const pages = await this.browser.pages();
    for (const page of pages) {
      const url = page.url();
      if (url.startsWith("chrome://") || url.startsWith("devtools://")) continue;
      const targetId = targetIdOf(page);
      if ([...this.tabs.values()].some((tab) => tab.targetId === targetId)) continue;
      await this.attachPage(page, false, undefined, false);
    }
  }

  /** List tabs with their current titles and ownership. */
  async listTabs(): Promise<TabInfo[]> {
    await this.syncTabs();
    const infos = await Promise.all(
      [...this.tabs.values()].map(async (tab) => ({
        handle: tab.handle,
        targetId: tab.targetId,
        url: tab.page.isClosed() ? "" : tab.page.url(),
        title:
          tab.page.isClosed() || this.pendingDialog ? "" : await tab.page.title().catch(() => ""),
        current: tab.handle === this.current,
        owned: tab.owned,
        lastUsed: tab.lastUsed,
      })),
    );
    return infos.sort((a, b) => a.handle - b.handle);
  }

  /** Select a tab and bring its window to the front. */
  async selectTab(handle: number): Promise<TabInfo> {
    const tab = this.tabs.get(handle);
    if (!tab || tab.page.isClosed()) {
      throw new BrowserPilotError(
        `Tab ${handle} is not open.`,
        'Run tabs {op:"list"} to see open tabs.',
      );
    }
    this.current = handle;
    tab.lastUsed = Date.now();
    await tab.page.bringToFront().catch(() => undefined);
    this.persist();
    const infos = await this.listTabs();
    return infos.find((info) => info.handle === handle)!;
  }

  /** Close one tab. */
  async closeTab(handle: number): Promise<void> {
    const tab = this.tabs.get(handle);
    if (!tab) {
      throw new BrowserPilotError(
        `Tab ${handle} is not open.`,
        'Run tabs {op:"list"} to see open tabs.',
      );
    }
    if (!tab.page.isClosed()) await tab.page.close().catch(() => undefined);
    this.tabs.delete(handle);
    if (this.current === handle) {
      this.current = [...this.tabs.values()].find(
        (candidate) => !candidate.page.isClosed(),
      )?.handle;
    }
    this.persist();
  }

  /** Close agent-owned tabs other than the current one. */
  async closeOtherTabs(): Promise<number> {
    const victims = [...this.tabs.values()].filter(
      (tab) => tab.owned && tab.handle !== this.current,
    );
    for (const tab of victims) await this.closeTab(tab.handle);
    return victims.length;
  }

  /** Close agent-owned, non-current tabs that have been idle for a while. */
  async cleanupTabs(): Promise<number> {
    const cutoff = Date.now() - TAB_IDLE_CLEANUP_MS;
    const victims = [...this.tabs.values()].filter(
      (tab) => tab.owned && tab.handle !== this.current && tab.lastUsed < cutoff,
    );
    for (const tab of victims) await this.closeTab(tab.handle);
    return victims.length;
  }

  /** Navigate the current or specified tab. */
  async navigate(
    url: string | undefined,
    direction: "back" | "forward" | "reload" | undefined,
    waitUntil: "load" | "domcontentloaded" | "networkidle0" | "networkidle2" | undefined,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
    tabHandle?: number,
  ): Promise<NavigateResult> {
    const tab = await this.ensureTab(tabHandle);
    const page = tab.page;
    const timeout = timeoutMs ?? this.config.navigationTimeoutSeconds * 1000;
    const wait = waitUntil ?? "domcontentloaded";
    let status = 200;
    let note: string | undefined;

    if (direction) {
      const options = { waitUntil: wait, timeout, signal };
      if (direction === "back") {
        const response = await page.goBack(options);
        if (!response) note = "No earlier history entry.";
        else status = response.status();
      } else if (direction === "forward") {
        const response = await page.goForward(options);
        if (!response) note = "No later history entry.";
        else status = response.status();
      } else {
        const response = await page.reload(options);
        status = response?.status() ?? 200;
      }
    } else if (url) {
      const guard = await checkNavigationAllowed(url, this.config.allowPrivateHosts);
      if (!guard.allowed) {
        throw new BrowserPilotError(
          `Navigation blocked: ${guard.reason ?? url}`,
          "Set allowPrivateHosts to true in browser-pilot.json to permit local development hosts.",
        );
      }
      const response = await page.goto(url, { waitUntil: wait, timeout, signal });
      status = response?.status() ?? 200;
    } else {
      throw new BrowserPilotError(
        "navigate requires a url, or direction back/forward/reload.",
        'Example: {action:"navigate", url:"https://example.com"}',
      );
    }

    tab.lastUsed = Date.now();
    this.refs.clear();
    this.snapshotCount++;
    this.challenge = await detectChallenge(page).catch(() => undefined);
    this.persist();
    return {
      tab: (await this.listTabs()).find((info) => info.handle === tab.handle)!,
      status,
      url: page.url(),
      title: await page.title().catch(() => ""),
      challenge: this.challenge,
      note,
    };
  }

  /** Reset the idle-close timer after a successful or failed action. */
  touch(): void {
    if (this.disposed || this.config.idleCloseSeconds <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.dispose();
    }, this.config.idleCloseSeconds * 1000);
    this.idleTimer.unref?.();
  }

  /** Close the browser and forget this session's state. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const instance = this.instance;
    const profile = this.profile;
    const browser = this.browser;
    this.browser = undefined;
    this.instance = undefined;
    this.tabs.clear();
    this.current = undefined;
    try {
      rmSync(this.sessionRecordPath(), { force: true });
    } catch {
      // Best effort.
    }
    if (instance?.external) {
      browser?.disconnect();
    } else if (instance) {
      await closeChrome({
        browser,
        pid: instance.pid,
        recordPath: instanceRecordPath(this.agentDir, profile?.key ?? "shared"),
        userDataDir: instance.userDataDir,
        deleteProfile: profile ? !profile.persistent : false,
      });
    }
  }

  /** Synchronously kill the browser for process-exit cleanup. */
  disposeSync(force = false): void {
    if (!force && !this.config.closeOnExit) return;
    this.disposed = true;
    if (this.instance) disposeChromeSync(this.instance.pid);
  }
}

/** One session per pi session id. */
const sessions = new Map<string, BrowserPilotSession>();
let exitHandlerRegistered = false;

/** Get or create the session for this pi session. */
export function getBrowserPilotSession(options: {
  sessionId: string;
  agentDir: string;
  cwd: string;
  config: BrowserPilotConfig;
}): BrowserPilotSession {
  let session = sessions.get(options.sessionId);
  if (!session || session.isDisposed) {
    session = new BrowserPilotSession(options);
    sessions.set(options.sessionId, session);
    registerExitHandler();
  } else {
    // Keep a profile chosen by a previous open call once a browser exists.
    const profile = session.instance ? session.config.profile : options.config.profile;
    session.config = { ...options.config, profile };
  }
  return session;
}

/** Close sessions that are configured to close on exit. */
export async function disposeAllSessions(force = false): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(
    all
      .filter((session) => force || session.config.closeOnExit)
      .map((session) => session.dispose().catch(() => undefined)),
  );
}

/** Kill every session's browser synchronously. */
export function disposeAllSessionsSync(force = false): void {
  for (const session of sessions.values()) session.disposeSync(force);
  sessions.clear();
}

function registerExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.once("exit", () => {
    for (const session of sessions.values()) session.disposeSync();
    sessions.clear();
  });
}

function targetIdOf(page: Page): string {
  const target = page.target() as unknown as { _targetId?: string };
  return target._targetId ?? page.url();
}

function platformToken(): string {
  if (process.platform === "win32") return "Windows NT 10.0; Win64; x64";
  if (process.platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  return "X11; Linux x86_64";
}

function safeResourceType(request: HTTPRequest): string | undefined {
  try {
    return request.resourceType();
  } catch {
    return undefined;
  }
}

function headerValue(response: HTTPResponse, name: string): string | undefined {
  try {
    return response.headers()[name];
  } catch {
    return undefined;
  }
}

function trim<T>(items: T[], limit: number): void {
  while (items.length > limit) items.shift();
}

async function resolveDevToolsEndpoint(endpoint: string): Promise<string> {
  const trimmed = endpoint.trim();
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (/^wss?:\/\//i.test(withScheme)) return withScheme;
  if (!/^https?:\/\//i.test(withScheme)) {
    throw new BrowserPilotError(
      `Unsupported endpoint scheme: ${endpoint}`,
      "Use a ws:// DevTools endpoint or an http:// endpoint exposing /json/version.",
    );
  }
  const base = withScheme.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${base}/json/version`);
  } catch (error) {
    throw new BrowserPilotError(
      `Could not reach ${base}: ${error instanceof Error ? error.message : String(error)}`,
      "Check that Chrome is running with --remote-debugging-port and the port is reachable.",
    );
  }
  if (!response.ok) {
    throw new BrowserPilotError(
      `DevTools endpoint ${base}/json/version returned ${response.status}.`,
    );
  }
  const data = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof data.webSocketDebuggerUrl !== "string") {
    throw new BrowserPilotError(`DevTools endpoint ${base} did not return a websocket URL.`);
  }
  return data.webSocketDebuggerUrl;
}

function safeFilename(value: string): string {
  const cleaned = Array.from(basename(value))
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  return cleaned || `download-${Date.now()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function sanitizeFile(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80) || `session-${process.pid}`;
}

/** Resolve the profile a session would use without launching a browser. */
export function previewProfile(
  config: BrowserPilotConfig,
  sessionId: string,
  agentDir: string,
  cwd: string,
): ProfileInfo {
  return resolveProfile(config.profile, sessionId, agentDir, cwd);
}
