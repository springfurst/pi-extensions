/**
 * One browser per profile, shared by every session in this process.
 *
 * A runtime keeps the process, its DevTools connection, and the page pool.
 * Sessions lease the browser, create pages inside it, and see only their own
 * tabs. Closing a session releases its pages and its lease; the process is only
 * closed when the last lease goes and this process started it. When a browser
 * already serves the profile — from another session or another process — the
 * runtime attaches instead of failing on the profile lock.
 */

import type { Clock } from "../web/clock";
import { SlidingWindow, type RequestLimiter } from "../web/limiter";
import type { HostStateStore } from "../web/politeness";
import type { IsolationMode, SessionHandle, SessionOptions } from "../web/types";
import {
  closeChrome,
  connectChrome,
  disposeChromeSync,
  ensureChrome,
  type ChromeLaunchConfig,
  type EnsureChromeOptions,
} from "./launch";
import { PagePool } from "./pool";
import {
  instanceRecordPath,
  resolveProfile,
  type ChromeInstance,
  type ProfileInfo,
} from "./profile";

/** The subset of a Puppeteer page the runtime tracks. */
export interface PageLike {
  url(): string;
  isClosed(): boolean;
  close(): Promise<void>;
}

/** The subset of a Puppeteer browser context the runtime uses. */
export interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

/** The subset of a Puppeteer browser the runtime uses. */
export interface BrowserLike {
  connected: boolean;
  newPage(): Promise<PageLike>;
  pages(): Promise<PageLike[]>;
  on(event: "disconnected", listener: () => void): unknown;
  close(): Promise<void>;
  disconnect(): void;
  createBrowserContext?(): Promise<ContextLike>;
}

/** One browser process and the sessions leasing it. */
export interface RuntimeLease {
  readonly profile: ProfileInfo;
  readonly instance: ChromeInstance;
  readonly browser: BrowserLike;
}

/** Options for constructing a runtime. */
export interface BrowserRuntimeOptions {
  agentDir: string;
  cwd: string;
  config: ChromeLaunchConfig;
  /** Attach to a live endpoint instead of refusing a busy profile. */
  attach: boolean;
  /** Pages allowed across every session. */
  maxPages: number;
  /** Tabs a session may hold open at once. */
  maxTabsPerSession: number;
  tabsPerMinutePerSession?: number;
  tabsPerMinuteGlobal?: number;
  clock?: Clock;
  /** Pacing budget for navigations, shared with the HTTP transport. */
  navigation?: { limiter: RequestLimiter; store: HostStateStore };
  /** Injectable process/connection functions, for tests and embedding. */
  ensure?: (options: EnsureChromeOptions) => Promise<{
    instance: ChromeInstance;
    profile: ProfileInfo;
    attached?: boolean;
  }>;
  connect?: (instance: ChromeInstance) => Promise<BrowserLike>;
  closeBrowser?: typeof closeChrome;
  isPidAlive?: (pid: number) => boolean;
}

/** The pacing budget one caller spends before a navigation. */
export interface NavigationBudget {
  limiter: RequestLimiter;
  store: HostStateStore;
}

/** A tab open refused by the per-session or global tab budget. */
export class TabLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "TabLimitError";
  }
}

interface Slot {
  profile: ProfileInfo;
  instance: ChromeInstance;
  browser: BrowserLike;
  leases: Set<string>;
  /** True when this process spawned the browser and may close it. */
  launchedHere: boolean;
  recordPath: string;
  /** True once the process was closed through this runtime. */
  closed: boolean;
  /** Which session owns each page; shared by every session on this process. */
  owner: Map<PageLike, string>;
}

interface SessionState {
  id: string;
  isolation: IsolationMode;
  slot: Slot;
  context?: ContextLike;
  /** Per-session tab cap and open-rate window. */
  maxTabs: number;
  tabs: SlidingWindow;
  /** Pages this session owns. */
  owned: Set<PageLike>;
  /** Pool slot release for each page this session created. */
  releases: Map<PageLike, () => void>;
}

/** Per-session limits a caller may override when it leases the browser. */
export interface SessionLimits {
  /** Tabs this session may hold open at once. */
  maxTabs?: number;
  /** Tabs this session may open per minute. */
  tabsPerMinute?: number;
}

const TAB_WINDOW_MS = 60_000;

/** A session's handle on the shared browser. */
export interface RuntimeSessionHandle extends SessionHandle {
  /** Open a page within the tab and page budgets. */
  createPage(signal?: AbortSignal): Promise<PageLike>;
  /** Pages this session owns. */
  pages(): Promise<PageLike[]>;
  /** Close one of this session's pages and free its slot. */
  closePage(page: PageLike): Promise<void>;
  /** Claim a page the browser opened, unless another session owns it. */
  claim(page: PageLike): boolean;
  /** True when the page belongs to this session. */
  owns(page: PageLike): boolean;
  /** True when this session may address the page. */
  visible(page: PageLike): boolean;
  /** Release this session; the browser closes only when it is the last lease. */
  close(): Promise<void>;
  /** Release this session and report who else is still using the browser. */
  closeBrowser(): Promise<{ sharedWith: string[] }>;
}

/** Process and page lifecycle shared by every web tool. */
export class BrowserRuntime {
  private readonly ensure: NonNullable<BrowserRuntimeOptions["ensure"]>;
  private readonly connect: NonNullable<BrowserRuntimeOptions["connect"]>;
  private readonly closeBrowserImpl: NonNullable<BrowserRuntimeOptions["closeBrowser"]>;
  private readonly clock?: Clock;
  private readonly pool: PagePool;
  private readonly globalTabs: SlidingWindow;
  private readonly slots = new Map<string, Slot>();
  private readonly sessions = new Map<string, SessionState>();
  /** Pages currently being opened; target watchers must not claim them. */
  private pendingOpens = 0;

  constructor(private readonly options: BrowserRuntimeOptions) {
    this.ensure = options.ensure ?? ensureChrome;
    this.connect = options.connect ?? connectChrome;
    this.closeBrowserImpl = options.closeBrowser ?? closeChrome;
    this.clock = options.clock;
    this.pool = new PagePool({ maxPages: options.maxPages });
    this.globalTabs = new SlidingWindow({
      limit: options.tabsPerMinuteGlobal ?? 10,
      windowMs: TAB_WINDOW_MS,
      clock: options.clock,
    });
  }

  /** Lease the browser and return a handle bound to one session id. */
  async openSession(
    sessionId: string,
    options: SessionOptions & SessionLimits & { signal?: AbortSignal },
  ): Promise<RuntimeSessionHandle> {
    await this.acquire(sessionId, options);
    return new RuntimeSession(this, sessionId, options.isolation);
  }

  /** Lease the profile's browser for a session, attaching when it is live. */
  async acquire(
    sessionId: string,
    options: { isolation?: IsolationMode; signal?: AbortSignal } & SessionLimits = {},
  ): Promise<RuntimeLease> {
    const existing = this.sessions.get(sessionId);
    if (existing) return this.leaseOf(existing.slot);

    const resolved = resolveProfile(
      this.options.config.profile,
      sessionId,
      this.options.agentDir,
      this.options.cwd,
    );
    let slot = this.slots.get(resolved.key);
    if (!slot || !slot.browser.connected) {
      slot = await this.openSlot(resolved, sessionId, options.signal);
    }
    const isolation = options.isolation ?? "tabs";
    const state: SessionState = {
      id: sessionId,
      isolation,
      slot,
      maxTabs: options.maxTabs ?? this.options.maxTabsPerSession,
      tabs: new SlidingWindow({
        limit: options.tabsPerMinute ?? this.options.tabsPerMinutePerSession ?? 2,
        windowMs: TAB_WINDOW_MS,
        clock: this.clock,
      }),
      owned: new Set(),
      releases: new Map(),
    };
    if (isolation === "contexts") {
      const createContext = slot.browser.createBrowserContext;
      if (!createContext) {
        throw new Error("This browser cannot create an isolated context.");
      }
      state.context = await createContext.call(slot.browser);
    }
    slot.leases.add(sessionId);
    this.sessions.set(sessionId, state);
    return this.leaseOf(slot);
  }

  /**
   * Spend the host's navigation budget before a browser navigation. A caller
   * may supply its own budget so a shared process does not inherit another
   * tool's learned host intervals.
   */
  async beforeNavigation(
    url: string,
    signal?: AbortSignal,
    budget: NavigationBudget | undefined = this.options.navigation,
  ): Promise<void> {
    const navigation = budget;
    if (!navigation) return;
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    if (!host) return;
    await navigation.limiter.schedule(
      { host, minIntervalMs: navigation.store.intervalMs(host), signal },
      async () => undefined,
    );
  }

  /** Open a page for a session within the tab and page budgets. */
  async createPage(sessionId: string, signal?: AbortSignal): Promise<PageLike> {
    const state = this.sessionState(sessionId);
    this.takeTabSlot(state);
    return this.openPage(state, signal);
  }

  /**
   * Open a short-lived page for a tool render. Render pages use the page pool
   * and ownership rules but not the tab-per-minute windows, which exist to keep
   * user-visible tab opening from tripping challenge services; renders are
   * paced by the host navigation budget instead.
   */
  async createRenderPage(sessionId: string, signal?: AbortSignal): Promise<PageLike> {
    return this.openPage(this.sessionState(sessionId), signal);
  }

  private async openPage(state: SessionState, signal?: AbortSignal): Promise<PageLike> {
    const release = await this.pool.acquire(state.id, signal);
    let page: PageLike | undefined;
    this.pendingOpens++;
    try {
      page = state.context ? await state.context.newPage() : await state.slot.browser.newPage();
      state.owned.add(page);
      state.slot.owner.set(page, state.id);
      state.releases.set(page, release);
      return page;
    } catch (error) {
      release();
      throw error;
    } finally {
      this.pendingOpens--;
    }
  }

  /**
   * True while a session is opening a page. Browser target watchers check this
   * before claiming an unowned page, because the browser announces a new page
   * before the opening session records ownership.
   */
  pageOpenInFlight(): boolean {
    return this.pendingOpens > 0;
  }

  /** Close a session's page and free its pool slot. */
  async closePage(sessionId: string, page: PageLike): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state && state.slot.owner.get(page) === sessionId) {
      state.owned.delete(page);
      state.slot.owner.delete(page);
    }
    state?.releases.get(page)?.();
    state?.releases.delete(page);
    await page.close().catch(() => undefined);
  }

  /** Claim an existing page for a session. False when another session owns it. */
  claim(sessionId: string, page: PageLike): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) return false;
    const owner = state.slot.owner.get(page);
    if (owner !== undefined && owner !== sessionId) return false;
    state.slot.owner.set(page, sessionId);
    state.owned.add(page);
    return true;
  }

  /** True when the page is owned by this session. */
  owns(sessionId: string, page: PageLike): boolean {
    return this.sessions.get(sessionId)?.slot.owner.get(page) === sessionId;
  }

  /** True when the session may see and address the page. */
  visible(sessionId: string, page: PageLike): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) return false;
    const owner = state.slot.owner.get(page);
    return owner === undefined || owner === sessionId;
  }

  /** Pages this session owns, in the browser's order. */
  async sessionPages(sessionId: string): Promise<PageLike[]> {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    this.prune(state);
    return [...state.owned];
  }

  /** True when this process spawned the browser the session leases. */
  ownsProcess(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.slot.launchedHere ?? false;
  }

  /** Session ids currently leasing the profile's browser besides `sessionId`. */
  otherLeases(sessionId: string): string[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    return [...state.slot.leases].filter((id) => id !== sessionId);
  }

  /** Release a session: close its pages, drop its lease, maybe close the browser. */
  async release(sessionId: string, options: { closePages?: boolean } = {}): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const closePages = options.closePages ?? true;
    for (const page of [...state.owned]) {
      if (closePages) await page.close().catch(() => undefined);
      state.releases.get(page)?.();
      state.releases.delete(page);
    }
    await state.context?.close().catch(() => undefined);
    this.sessions.delete(sessionId);
    state.slot.leases.delete(sessionId);
    if (state.slot.leases.size === 0) {
      this.slots.delete(state.slot.profile.key);
      if (state.slot.launchedHere) await this.closeSlot(state.slot);
    }
  }

  /**
   * End a session's use of the browser. The process is closed only when this
   * session was the last lease and this process started it; otherwise the
   * browser stays up for the sessions that remain.
   */
  async closeBrowser(sessionId: string): Promise<{ sharedWith: string[] }> {
    const state = this.sessions.get(sessionId);
    if (!state) return { sharedWith: [] };
    const others = this.otherLeases(sessionId);
    const slot = state.slot;
    await this.release(sessionId);
    if (others.length === 0 && !slot.launchedHere && !slot.closed) {
      // Attached to a browser this process does not own: disconnect only.
      slot.browser.disconnect();
      slot.closed = true;
      this.slots.delete(slot.profile.key);
    }
    return { sharedWith: others };
  }

  /** Release every session; used on process exit and by tests. */
  async releaseAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.release(id);
  }

  /** Kill processes this runtime launched, for synchronous exit cleanup. */
  disposeSync(): void {
    for (const slot of this.slots.values()) {
      if (slot.launchedHere) disposeChromeSync(slot.instance.pid);
    }
    this.slots.clear();
    this.sessions.clear();
  }

  /** The connected browser this process already has open, if any. */
  liveBrowser(): BrowserLike | undefined {
    for (const slot of this.slots.values()) {
      if (slot.browser.connected && !slot.closed) return slot.browser;
    }
    return undefined;
  }

  /** True when another session still leases the browser this session uses. */
  hasOtherLeases(sessionId: string): boolean {
    return this.otherLeases(sessionId).length > 0;
  }

  private async openSlot(
    profile: ProfileInfo,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<Slot> {
    const { instance, attached } = await this.ensure({
      config: this.options.config,
      sessionId,
      agentDir: this.options.agentDir,
      cwd: this.options.cwd,
      attach: this.options.attach,
      signal,
    });
    const browser = await this.connect(instance);
    const slot: Slot = {
      profile,
      instance,
      browser,
      leases: new Set(),
      launchedHere: !attached,
      recordPath: instanceRecordPath(this.options.agentDir, profile.key),
      closed: false,
      owner: new Map(),
    };
    browser.on("disconnected", () => {
      this.slots.delete(profile.key);
    });
    this.slots.set(profile.key, slot);
    return slot;
  }

  private async closeSlot(slot: Slot): Promise<void> {
    slot.closed = true;
    await this.closeBrowserImpl({
      // Puppeteer's Browser satisfies BrowserLike; the cast keeps this module
      // free of a direct puppeteer dependency.
      browser: slot.browser as unknown as Parameters<typeof closeChrome>[0]["browser"],
      pid: slot.instance.pid,
      recordPath: slot.recordPath,
      userDataDir: slot.profile.userDataDir,
      deleteProfile: !slot.profile.persistent,
    });
  }

  /** Drop pages the browser or the user closed so their slots come back. */
  private prune(state: SessionState): void {
    for (const page of [...state.owned]) {
      if (!page.isClosed()) continue;
      state.owned.delete(page);
      state.slot.owner.delete(page);
      state.releases.get(page)?.();
      state.releases.delete(page);
    }
  }

  private takeTabSlot(state: SessionState): void {
    this.prune(state);
    const openTabs = state.owned.size;
    if (openTabs >= state.maxTabs) {
      throw new TabLimitError(
        `This session already has ${openTabs} tabs open (maxTabs ${state.maxTabs}).`,
        0,
      );
    }
    if (!state.tabs.take()) {
      throw new TabLimitError(
        `Tab creation is limited to ${state.tabs.limit} per minute per session.`,
        state.tabs.nextAvailableAt() - (this.clock?.now() ?? Date.now()),
      );
    }
    if (!this.globalTabs.take()) {
      throw new TabLimitError(
        `Tab creation is limited to ${this.options.tabsPerMinuteGlobal ?? 10} per minute across sessions.`,
        this.globalTabs.nextAvailableAt() - (this.clock?.now() ?? Date.now()),
      );
    }
  }

  private leaseOf(slot: Slot): RuntimeLease {
    return { profile: slot.profile, instance: slot.instance, browser: slot.browser };
  }

  private sessionState(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`No browser session is open for ${sessionId}.`);
    return state;
  }
}

const sharedRuntimes = new Map<string, BrowserRuntime>();
let exitHandlerRegistered = false;

/**
 * The process-wide runtime for a profile. Callers that would launch the same
 * profile share one runtime, one page pool, and one browser process. The first
 * caller decides the launch configuration; later callers attach to what runs.
 */
export function sharedBrowserRuntime(options: BrowserRuntimeOptions): BrowserRuntime {
  const key = runtimeKey(options);
  let runtime = sharedRuntimes.get(key);
  if (runtime) return runtime;
  runtime = new BrowserRuntime(options);
  sharedRuntimes.set(key, runtime);
  registerRuntimeExitHandler();
  return runtime;
}

/** Drop the process-wide runtimes; tests call this between cases. */
export function resetSharedBrowserRuntimes(): void {
  sharedRuntimes.clear();
}

/** The runtimes this process opened, for status and tests. */
export function sharedRuntimeEntries(): Array<[string, BrowserRuntime]> {
  return [...sharedRuntimes.entries()];
}

function runtimeKey(options: BrowserRuntimeOptions): string {
  return JSON.stringify([
    options.agentDir,
    options.cwd,
    options.config.profile,
    options.attach,
    options.maxPages,
    Boolean(options.ensure),
    Boolean(options.connect),
    Boolean(options.closeBrowser),
    Boolean(options.clock),
  ]);
}

function registerRuntimeExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.once("exit", () => {
    for (const runtime of sharedRuntimes.values()) runtime.disposeSync();
    sharedRuntimes.clear();
  });
}

/** A bound view of the runtime for one session. */
class RuntimeSession implements RuntimeSessionHandle {
  constructor(
    private readonly runtime: BrowserRuntime,
    readonly id: string,
    readonly isolation: IsolationMode,
  ) {}

  createPage(signal?: AbortSignal): Promise<PageLike> {
    return this.runtime.createPage(this.id, signal);
  }

  pages(): Promise<PageLike[]> {
    return this.runtime.sessionPages(this.id);
  }

  closePage(page: PageLike): Promise<void> {
    return this.runtime.closePage(this.id, page);
  }

  claim(page: PageLike): boolean {
    return this.runtime.claim(this.id, page);
  }

  owns(page: PageLike): boolean {
    return this.runtime.owns(this.id, page);
  }

  visible(page: PageLike): boolean {
    return this.runtime.visible(this.id, page);
  }

  close(): Promise<void> {
    return this.runtime.release(this.id);
  }

  closeBrowser(): Promise<{ sharedWith: string[] }> {
    return this.runtime.closeBrowser(this.id);
  }
}
