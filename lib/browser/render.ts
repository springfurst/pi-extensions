/**
 * Browser rendering over the shared runtime.
 *
 * Every web tool renders through the same process the browser-pilot leases:
 * one runtime per profile, one page pool, one warm identity. A render opens a
 * short-lived page, guards and paces the navigation, applies subresource
 * blocking, and returns the live DOM.
 */

import type { BrowserConfig } from "../config";
import { checkUrlAllowed, type ResolveHost } from "../security";
import type { BlockingConfig, HostPolicy, RuntimeConfig } from "../web/config";
import type { IsolationMode } from "../web/types";
import { findHostPolicy, type Politeness } from "../web/politeness";
import {
  BROWSER_VIEWPORT,
  isBlockedRequestUrl,
  resolveBrowserExecutable,
  type BrowserPage,
  type BrowserRenderer,
  type CreateBrowserRendererOptions,
  type InterceptableRequest,
  type RenderedPage,
  type RenderPageOptions,
} from "../browser";
import { cookieHeaderFor, type CookieJar } from "./cookies";
import { DEFAULT_BLOCKING, shouldBlockRequest } from "./blocking";
import { PagePool } from "./pool";
import {
  sharedBrowserRuntime,
  type BrowserRuntime,
  type NavigationBudget,
  type PageLike,
  type RuntimeSessionHandle,
} from "./runtime";

/** Session id the web tools lease; distinct from any pi session id. */
export const WEB_TOOLS_SESSION = "web-tools";

/** A page the renderer can drive. The runtime hands out real Puppeteer pages. */
export type RenderPage = PageLike & BrowserPage;

export interface RuntimeRendererOptions {
  agentDir: string;
  cwd: string;
  config: BrowserConfig;
  runtimeConfig: RuntimeConfig;
  /** Pacing budget for navigations; absent leaves them unpaced. */
  politeness?: Politeness;
  blocking?: BlockingConfig;
  hosts?: Record<string, HostPolicy>;
  resolve?: ResolveHost;
  /** Runtime override, primarily for tests. */
  runtime?: BrowserRuntime;
}

/**
 * One renderer per runtime: tool calls build a context per call, and the
 * renderer holds the lease, the local page cap, and the idle timer that must
 * survive between calls.
 */
const renderers = new WeakMap<BrowserRuntime, BrowserRenderer>();

/**
 * The process-wide runtime these options would use, created without launching
 * anything. Probe cookie reads and the renderer must agree on the instance, so
 * both call this.
 */
export function browserRuntimeFor(options: CreateBrowserRendererOptions): BrowserRuntime {
  if (options.runtime) return options.runtime;
  const profile = options.config.userDataDir ?? options.runtimeConfig.profile;
  return sharedBrowserRuntime({
    agentDir: options.agentDir,
    cwd: options.cwd,
    config: {
      profile,
      headless: options.runtimeConfig.headless,
      viewport: BROWSER_VIEWPORT,
      // Match the browser-pilot defaults so both tools may share one process.
      stealth: "basic",
      noSandbox: options.config.noSandbox,
      args: [],
      executablePath: options.executablePath ?? options.config.executablePath,
    },
    attach: options.runtimeConfig.attach === "auto",
    maxPages: options.runtimeConfig.maxPages,
    maxTabsPerSession: 1,
    ensure: options.ensure,
    connect: options.connect,
    closeBrowser: options.closeBrowser,
    navigation: options.politeness
      ? { limiter: options.politeness.limiter, store: options.politeness.store }
      : undefined,
  });
}

/**
 * A `Cookie` header for a URL from the profile's live browser, if this process
 * already has it open. Probes stay on HTTP but keep the warm identity.
 */
export async function cookiesForUrl(
  runtime: BrowserRuntime,
  url: string,
): Promise<string | undefined> {
  const browser = runtime.liveBrowser();
  if (!browser || typeof (browser as { cookies?: unknown }).cookies !== "function")
    return undefined;
  return cookieHeaderFor(browser as unknown as CookieJar, url);
}

/**
 * Build a renderer over the shared browser runtime. The binary is resolved
 * before the renderer exists, so a machine without a browser keeps the tools'
 * existing "browser unavailable" behavior instead of failing a call.
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
  const runtime = browserRuntimeFor({ ...options, executablePath });
  const existing = renderers.get(runtime);
  if (existing) return existing;
  const renderer = runtimeRenderer(runtime, {
    config: options.config,
    isolation: options.runtimeConfig.isolation,
    politeness: options.politeness,
    blocking: options.blocking,
    hosts: options.hosts,
    resolve: options.resolve,
  });
  renderers.set(runtime, renderer);
  return renderer;
}

function runtimeRenderer(
  runtime: BrowserRuntime,
  options: Pick<
    RuntimeRendererOptions,
    "config" | "politeness" | "blocking" | "hosts" | "resolve"
  > & { isolation: IsolationMode },
): BrowserRenderer {
  const { config } = options;
  const localPool = new PagePool({ maxPages: config.maxPages });
  const navigation: NavigationBudget | undefined = options.politeness
    ? { limiter: options.politeness.limiter, store: options.politeness.store }
    : undefined;
  let session: RuntimeSessionHandle | undefined;
  let sessionPromise: Promise<RuntimeSessionHandle> | undefined;
  let activeRenders = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelIdleClose = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const scheduleIdleClose = (): void => {
    if (config.idleCloseSeconds <= 0 || activeRenders > 0 || !session) return;
    cancelIdleClose();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      const current = session;
      session = undefined;
      sessionPromise = undefined;
      // Release the lease; the shared process closes only when no one else uses it.
      void current?.close().catch(() => undefined);
    }, config.idleCloseSeconds * 1000);
    idleTimer.unref?.();
  };

  const ensureSession = (signal?: AbortSignal): Promise<RuntimeSessionHandle> => {
    if (session) return Promise.resolve(session);
    sessionPromise ??= runtime
      .openSession(WEB_TOOLS_SESSION, { isolation: options.isolation, signal })
      .then((handle) => {
        session = handle;
        return handle;
      })
      .finally(() => {
        sessionPromise = undefined;
      });
    return sessionPromise;
  };

  return async (url, renderOptions = {}) => {
    const timeoutMs = Math.min(
      renderOptions.timeoutMs ?? config.timeoutSeconds * 1000,
      config.timeoutSeconds * 1000,
    );
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = renderOptions.signal
      ? AbortSignal.any([renderOptions.signal, deadline])
      : deadline;

    if (!config.allowPrivateHosts) {
      const guard = await checkUrlAllowed(url, {
        allowPrivateHosts: false,
        resolve: options.resolve,
      });
      if (!guard.allowed) throw new Error(`Blocked URL: ${guard.reason ?? url}`);
    }

    const handle = await ensureSession(signal);
    cancelIdleClose();
    const release = await localPool.acquire(WEB_TOOLS_SESSION, signal);
    activeRenders++;
    let page: RenderPage | undefined;
    try {
      page = (await runtime.createRenderPage(handle.id, signal)) as RenderPage;
      await configurePage(page, options);
      if (renderOptions.homeUrl) {
        await runtime.beforeNavigation(renderOptions.homeUrl, signal, navigation);
        await page.goto(renderOptions.homeUrl, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
          signal,
        });
      }
      await runtime.beforeNavigation(url, signal, navigation);
      let status = 200;
      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
          signal,
        });
        status = response?.status() ?? 200;
      } catch (error) {
        // A navigation timeout can still leave a rendered DOM; capture it below.
        if (signal.aborted) throw error;
        if (!isNavigationTimeout(error)) throw error;
      }
      if (renderOptions.readySelector && page.waitForSelector) {
        await page
          .waitForSelector(renderOptions.readySelector, {
            timeout: renderOptions.readyTimeoutMs ?? 10_000,
            signal: signal,
          })
          .catch(() => undefined);
      }
      const html = await page.content();
      const rendered: RenderedPage = { html, status, finalUrl: page.url() };
      return rendered;
    } finally {
      if (page) await runtime.closePage(handle.id, page).catch(() => undefined);
      release();
      activeRenders--;
      scheduleIdleClose();
    }
  };
}

/** Viewport, guard, and default subresource blocking for one render. */
async function configurePage(
  page: RenderPage,
  options: Pick<RuntimeRendererOptions, "config" | "blocking" | "hosts" | "resolve">,
): Promise<void> {
  if (page.setViewport) await page.setViewport({ ...BROWSER_VIEWPORT }).catch(() => undefined);
  await page.setRequestInterception(true).catch(() => undefined);
  page.on("request", (request) => {
    void handleRequest(request, options);
  });
}

async function handleRequest(
  request: InterceptableRequest,
  options: Pick<RuntimeRendererOptions, "config" | "blocking" | "hosts" | "resolve">,
): Promise<void> {
  try {
    const url = request.url();
    if (isBlockedRequestUrl(url, options.config.allowPrivateHosts)) {
      await request.abort();
      return;
    }
    const documentUrl = request.frame?.()?.url();
    const resourceType = request.resourceType?.();
    if (resourceType !== "document") {
      if (
        shouldBlockRequest(
          { url, documentUrl, resourceType },
          options.blocking ?? DEFAULT_BLOCKING,
          documentHostPolicy(documentUrl, options.hosts),
        )
      ) {
        await request.abort("blockedbyclient");
        return;
      }
    }
    if (!options.config.allowPrivateHosts && request.isNavigationRequest?.()) {
      const guard = await checkUrlAllowed(url, {
        allowPrivateHosts: false,
        resolve: options.resolve,
      });
      if (!guard.allowed) {
        await request.abort();
        return;
      }
    }
    await request.continue();
  } catch {
    // The request may already be settled after a navigation teardown.
  }
}

/** The document host's policy for matching `hosts.<host>.allow`, when known. */
function documentHostPolicy(
  documentUrl: string | undefined,
  hosts: Record<string, HostPolicy> | undefined,
): HostPolicy | undefined {
  if (!documentUrl || !hosts) return undefined;
  try {
    return findHostPolicy(new URL(documentUrl).host, hosts);
  } catch {
    return undefined;
  }
}

function isNavigationTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout/i.test(message);
}

export type { RenderPageOptions };
