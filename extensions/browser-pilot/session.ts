import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Browser, Dialog, Frame, HTTPRequest, Page, Target } from "puppeteer-core";
import {
  closeChrome,
  connectChrome,
  disposeChromeSync,
  ensureChrome,
  instanceRecordPath,
} from "./launcher";
import { expandTilde } from "../../lib/logging";
import { detectChallenge } from "./challenge";
import { DownloadTracker } from "./session-downloads";
import { EmulationController, type NetworkProfileName } from "./session-emulation";
import { MAX_HAR_BODY_BYTES, RecordingController } from "./session-recording";
import { RouteController } from "./session-routing";
import { FrameSelection } from "./session-frames";
import { NetworkDetailStore, type NetworkDetail } from "./session-network-details";
import {
  SESSION_SCHEMA,
  readSessionRecord,
  removeSessionRecord,
  sessionRecordPath,
} from "./session-records";
import {
  headerValue,
  resolveDevToolsEndpoint,
  safeResourceType,
  targetIdOf,
  trim,
} from "./session-helpers";
import { checkNavigationAllowed, type NavigationGuardOptions } from "./security";
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

const TAB_IDLE_CLEANUP_MS = 5 * 60_000;

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
  refs = new Map<string, { selector: string; snapshot: number; frame?: Frame; tab: number }>();
  snapshotCount = 0;
  readonly frames = new FrameSelection();
  dialogPolicy: "dismiss" | "accept" | "manual" = "dismiss";
  pendingDialog?: DialogInfo;
  challenge?: ChallengeInfo;
  readonly downloads = new DownloadTracker();
  readonly routeController = new RouteController(this);

  get routeRules(): RouteRule[] {
    return this.routeController.rules;
  }
  readonly emulationController = new EmulationController(this);

  get emulation(): EmulationState {
    return this.emulationController.state;
  }

  set emulation(value: EmulationState) {
    this.emulationController.state = value;
  }

  private pendingDialogHandle?: Dialog;
  private requestEntries = new WeakMap<HTTPRequest, NetworkEntry>();
  private networkSequence = 0;
  private networkDetails = new NetworkDetailStore();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  readonly recording = new RecordingController(this);

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
        this.downloads.reset();
      });
      this.watchTargets();
      await this.restoreExternal();
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
      this.downloads.reset();
    });
    this.watchTargets();
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
    this.watchTargets();
    await this.restoreExternal();
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
      await this.attachPage(page, false, undefined, false);
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
    if (!this.browser?.connected) return;
    await this.downloads.configure(this.browser, this.downloadsDir());
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
    return this.downloads.list(filter);
  }

  /** Wait for the newest matching download to finish. */
  waitForDownload(timeoutMs: number, filter?: string, signal?: AbortSignal): Promise<DownloadInfo> {
    return this.downloads.wait(timeoutMs, filter, signal);
  }

  /** Clear the download history, not the files on disk. */
  clearDownloads(): number {
    return this.downloads.clear();
  }

  /** Start recording a HAR. Existing network buffers are cleared. */
  startHar(): void {
    this.recording.startHar();
  }

  /** True while HAR capture is active. */
  get isRecordingHar(): boolean {
    return this.recording.isRecordingHar;
  }

  /** Clear captured network entries used by HAR export. */
  clearHar(): number {
    return this.recording.clearHar();
  }

  /** Stop recording and return a HAR document built from captured entries. */
  stopHar(): Promise<{ har: Record<string, unknown>; entries: number }> {
    return this.recording.stopHar();
  }

  /** Start a Chrome trace for one tab. */
  startTrace(tabHandle?: number): Promise<TabInfo> {
    return this.recording.startTrace(tabHandle);
  }

  /** Stop the active trace and return its JSON document. */
  stopTrace(): Promise<{ trace: unknown; events: number; tab?: number; timedOut: boolean }> {
    return this.recording.stopTrace();
  }

  /** Clear one tab's captured network entries and their detail handles. */
  clearNetwork(tab: ManagedTab): number {
    const count = tab.network.length;
    for (const entry of tab.network) this.networkDetails.delete(entry.id);
    tab.network.length = 0;
    return count;
  }

  /** Find a captured request by id across all tabs. */
  findNetworkEntry(id: string): { tab: ManagedTab; entry: NetworkEntry } | undefined {
    for (const tab of this.tabs.values()) {
      const entry = tab.network.find((candidate) => candidate.id === id);
      if (entry) return { tab, entry };
    }
    return undefined;
  }

  /** Retained request/response handles and cached body for one network entry. */
  networkDetail(id: string): NetworkDetail | undefined {
    return this.networkDetails.get(id);
  }

  /** Cache a response body preview for later reads. */
  cacheNetworkBody(id: string, body: string, bodyTruncated: boolean): void {
    this.networkDetails.cacheBody(id, body, bodyTruncated);
  }

  /** Clear retained request/response handles. */
  clearNetworkDetails(): void {
    this.networkDetails.clear();
  }

  /** Add a request interception rule and enable interception on every tab. */
  addRouteRule(rule: Omit<RouteRule, "id">): Promise<RouteRule> {
    return this.routeController.add(rule);
  }

  /** Remove one rule by id, disabling interception when no rules remain. */
  removeRouteRule(id: string): Promise<boolean> {
    return this.routeController.remove(id);
  }

  /** Remove all rules and disable interception. */
  clearRouteRules(): Promise<number> {
    return this.routeController.clear();
  }

  /** Apply the session's emulation overrides to one page. */
  applyEmulation(page: Page): Promise<void> {
    return this.emulationController.apply(page);
  }

  /** Replace the emulation state and apply it to the current tab. */
  setEmulation(tabHandle: number | undefined, state: EmulationState): Promise<TabInfo> {
    return this.emulationController.set(tabHandle, state);
  }

  /** Build the network emulation condition for a named profile. */
  networkProfile(name: NetworkProfileName) {
    return this.emulationController.networkProfile(name);
  }

  /** Grant or clear browser permissions for one origin. */
  setPermissions(
    permissions: string[],
    origin?: string,
    tabHandle?: number,
  ): Promise<{ origin: string; permissions: string[] }> {
    return this.emulationController.setPermissions(permissions, origin, tabHandle);
  }

  /** List frames for one tab, including the current selection. */
  listFrames(tab: ManagedTab) {
    return this.frames.list(tab);
  }

  /** Select a frame by index, or return to the main frame with undefined. */
  selectFrame(tab: ManagedTab, index: number | undefined): Frame {
    return this.frames.select(tab, index);
  }

  /** The selected frame for a tab, falling back to the main frame. */
  activeFrame(tab: ManagedTab): Frame {
    return this.frames.active(tab);
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
      found.lastUsed = Date.now();
      return found;
    }
    if (this.current !== undefined) {
      const current = this.tabs.get(this.current);
      if (current && !current.page.isClosed()) {
        current.lastUsed = Date.now();
        return current;
      }
    }
    const first = [...this.tabs.values()].find((candidate) => !candidate.page.isClosed());
    if (first) {
      this.current = first.handle;
      first.lastUsed = Date.now();
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
          if (url) {
            await this.navigate(url, undefined, undefined, undefined, signal);
          }
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
    tab.owned = true;
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
        if (owned) existing.owned = true;
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
        id: `r${++this.networkSequence}`,
        timestamp: new Date().toISOString(),
        method: request.method(),
        url: request.url(),
        resourceType: safeResourceType(request),
        startedAt: Date.now(),
        tab: tab.handle,
      };
      entry.requestHeaders = request.headers();
      if (this.recording.isRecordingHar) {
        entry.postData = request.postData() ?? undefined;
      }
      this.requestEntries.set(request, entry);
      this.networkDetails.touch(entry.id, { request });
      tab.network.push(entry);
      trim(tab.network, this.config.networkBuffer);
      if (this.routeRules.length > 0) void this.routeController.apply(tab, request);
    });
    page.on("response", (response) => {
      const entry = this.requestEntries.get(response.request());
      if (!entry) return;
      entry.status = response.status();
      entry.statusText = response.statusText();
      entry.mimeType = headerValue(response, "content-type");
      entry.durationMs = Date.now() - entry.startedAt;
      entry.responseHeaders = response.headers();
      entry.timing = response.timing();
      const length = Number.parseInt(headerValue(response, "content-length") ?? "", 10);
      if (Number.isFinite(length) && length >= 0) entry.size = length;
      this.networkDetails.touch(entry.id, { response });
      if (this.recording.isRecordingHar) {
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
      this.clearRefsForTab(tab.handle);
      if (this.current === tab.handle) {
        this.current = [...this.tabs.values()].find(
          (candidate) => !candidate.page.isClosed(),
        )?.handle;
      }
      this.persist();
    });
    page.on("popup", (popup) => {
      if (!popup || popup.isClosed()) return;
      const targetId = targetIdOf(popup);
      const existing = [...this.tabs.values()].find((candidate) => candidate.targetId === targetId);
      if (existing) {
        existing.owned = true;
        this.current = existing.handle;
        void popup.bringToFront().catch(() => undefined);
        this.persist();
        return;
      }
      const openTabs = [...this.tabs.values()].filter((candidate) => !candidate.page.isClosed());
      if (openTabs.length >= this.config.maxTabs) {
        void popup.close().catch(() => undefined);
        return;
      }
      void this.attachPage(popup, true, undefined, !this.instance?.external)
        .then(async (opened) => {
          opened.owned = true;
          this.current = opened.handle;
          await popup.bringToFront().catch(() => undefined);
          this.persist();
        })
        .catch(() => undefined);
    });
  }

  /** Watch for pages that do not emit a page-level popup event, such as noopener windows. */
  private watchTargets(): void {
    const browser = this.browser;
    if (!browser) return;
    browser.on("targetcreated", (target) => {
      void this.handleTargetCreated(target);
    });
  }

  private async handleTargetCreated(target: Target): Promise<void> {
    if (this.disposed || target.type() !== "page") return;
    const page = await target.page().catch(() => null);
    if (!page || page.isClosed()) return;
    const url = page.url();
    if (url.startsWith("chrome://") || url.startsWith("devtools://")) return;
    const targetId = targetIdOf(page);
    if ([...this.tabs.values()].some((tab) => tab.targetId === targetId)) return;
    const openTabs = [...this.tabs.values()].filter((tab) => !tab.page.isClosed());
    if (openTabs.length >= this.config.maxTabs) {
      await page.close().catch(() => undefined);
      return;
    }
    const owned = target.opener() !== undefined;
    const tab = await this.attachPage(page, owned, undefined, !this.instance?.external).catch(
      () => undefined,
    );
    if (!tab) return;
    if (owned) {
      this.current = tab.handle;
      await page.bringToFront().catch(() => undefined);
    } else if (this.current === undefined) {
      this.current = tab.handle;
    }
    this.persist();
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
    if (this.routeController.hasRules) {
      await page.setRequestInterception(true).catch(() => undefined);
    }
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
    return sessionRecordPath(this.agentDir, this.sessionId);
  }

  private readSessionRecord(): SessionRecord | undefined {
    return readSessionRecord(this.sessionRecordPath());
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
    this.clearRefsForTab(handle);
    if (this.current === handle) {
      this.current = [...this.tabs.values()].find(
        (candidate) => !candidate.page.isClosed(),
      )?.handle;
    }
    this.persist();
  }

  private clearRefsForTab(handle: number): void {
    for (const [ref, entry] of this.refs) {
      if (entry.tab === handle) this.refs.delete(ref);
    }
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
      // Same-document history entries navigate without a network response, so the URL is the
      // reliable signal that the history moved.
      const before = page.url();
      if (direction === "back") {
        const response = await page.goBack(options);
        if (response) status = response.status();
        else if (page.url() === before) note = "No earlier history entry.";
      } else if (direction === "forward") {
        const response = await page.goForward(options);
        if (response) status = response.status();
        else if (page.url() === before) note = "No later history entry.";
      } else {
        const response = await page.reload(options);
        status = response?.status() ?? 200;
      }
    } else if (url) {
      const guard = await checkNavigationAllowed(url, this.navigationGuardOptions());
      if (!guard.allowed) {
        throw new BrowserPilotError(
          `Navigation blocked: ${guard.reason ?? url}`,
          "Set allowPrivateHosts for local development hosts, or allowLocalFiles and localFileGlobs for local files, in browser-pilot.json.",
        );
      }
      const response = await page.goto(guard.url ?? url, { waitUntil: wait, timeout, signal });
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
    this.frames.reset(tab.handle);
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

  /** The configuration the navigation guard needs, including the working directory. */
  navigationGuardOptions(): NavigationGuardOptions {
    return {
      allowPrivateHosts: this.config.allowPrivateHosts,
      allowLocalFiles: this.config.allowLocalFiles,
      localFileGlobs: this.config.localFileGlobs,
      cwd: this.cwd,
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
      removeSessionRecord(this.sessionRecordPath());
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

export { previewProfile } from "./session-helpers";
