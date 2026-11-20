import {
  browserRuntimeFor,
  cookiesForUrl,
  createBrowserRenderer,
  type BrowserRenderer,
} from "../../lib/browser";
import type { BrowserConfig, FetchConfig } from "../../lib/config";
import { HttpCache } from "../../lib/web/cache";
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from "../../lib/web/config";
import { classifyResponse } from "../../lib/web/outcome";
import { sharedPoliteness, type Politeness } from "../../lib/web/politeness";
import type { BlockingConfig, HostPolicy, PolitenessConfig } from "../../lib/web/config";
import { WebRuntime, type BrowserTransport } from "../../lib/web/runtime";
import type { BrowserRuntime } from "../../lib/browser/runtime";
import type { WebResult } from "../../lib/web/types";
import { loadPage } from "./fetch";
import { siteHostDefaults } from "./scrapers/registry";
import type {
  ExecFn,
  FetchContext,
  FetchImpl,
  LoadPage,
  LoadPageOptions,
  ResolveHost,
} from "./types";

export interface CreateFetchContextOptions {
  config: FetchConfig;
  signal?: AbortSignal;
  fetch?: FetchImpl;
  resolve?: ResolveHost;
  cacheDir?: string;
  exec?: ExecFn;
  /** Agent directory, used for browser profiles and instance records. */
  agentDir?: string;
  /** Working directory, used to resolve a relative browser profile path. */
  cwd?: string;
  /** Optional browser renderer, threaded through to the reader chain. */
  renderPage?: BrowserRenderer;
  /** Browser config; when set (and enabled) a renderer is created on first use. */
  browserConfig?: BrowserConfig;
  /** Shared runtime settings for a renderer created here. */
  runtimeConfig?: RuntimeConfig;
  /** Subresource blocking passed to a renderer created here. */
  blocking?: BlockingConfig;
  /** Renderer factory override; defaults to `createBrowserRenderer`. */
  createRenderer?: BrowserRendererFactory;
  /** Politeness policy; absent leaves requests unpaced and robots-unchecked. */
  politeness?: PolitenessConfig;
  /** Per-host overrides applied to pacing and robots handling. */
  hosts?: Record<string, HostPolicy>;
  /** Session id recorded with requests; defaults to a stable fetch id. */
  sessionId?: string;
}

/** Everything a renderer needs, so both tools build the same request shape. */
export interface BrowserRenderRequest {
  agentDir: string;
  cwd: string;
  config: BrowserConfig;
  runtimeConfig: RuntimeConfig;
  politeness?: Politeness;
  blocking?: BlockingConfig;
  hosts?: Record<string, HostPolicy>;
  resolve?: ResolveHost;
  /** Runtime override, primarily for tests. */
  runtime?: BrowserRuntime;
}

/** Build a browser renderer from config; injectable so tests can observe laziness. */
export type BrowserRendererFactory = (
  request: BrowserRenderRequest,
) => Promise<BrowserRenderer | undefined>;

/**
 * Bind configuration, cancellation, and injectable transport into the context
 * pipeline stages and site handlers use.
 */
export function createFetchContext(options: CreateFetchContextOptions): FetchContext {
  const fetchImpl = options.fetch ?? fetch;
  // One wall-clock deadline for the whole call, not per request. Handlers and
  // digest probes fan out into many requests, so a per-request timeout alone
  // cannot bound tool latency.
  const deadline = AbortSignal.timeout(options.config.timeoutSeconds * 1000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  // One limiter and host-state store per process and cache directory, so
  // pacing and learned limits survive between tool calls. Site handlers declare
  // starting gaps for the hosts they contact; configured values win.
  const hosts = siteHostDefaults(options.hosts);
  const politeness: Politeness | undefined = options.politeness
    ? sharedPoliteness({
        dir: options.cacheDir ?? "",
        politeness: options.politeness,
        hosts,
      })
    : undefined;
  // Conditional GETs keep a repeat fetch cheap; entries are revalidated, so a
  // stale body is never served as fresh.
  const cache = options.cacheDir ? new HttpCache({ dir: options.cacheDir }) : undefined;
  // The runtime is created without launching anything; probes use it to read
  // the warm profile's cookies, and the renderer later leases the same browser.
  const browserRequest: BrowserRenderRequest | undefined =
    options.browserConfig && options.browserConfig.enabled
      ? {
          agentDir: options.agentDir ?? "",
          cwd: options.cwd ?? "",
          config: options.browserConfig,
          runtimeConfig: options.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
          politeness,
          blocking: options.blocking,
          hosts: options.hosts,
          resolve: options.resolve,
        }
      : undefined;
  const browserRuntime = browserRequest ? browserRuntimeFor(browserRequest) : undefined;
  const renderPage =
    options.renderPage ??
    (browserRequest && browserRuntime
      ? lazyBrowserRenderer(options.createRenderer ?? defaultBrowserRenderer, {
          ...browserRequest,
          runtime: browserRuntime,
        })
      : undefined);
  const cookiesFor = browserRuntime
    ? (url: string) => cookiesForUrl(browserRuntime, url)
    : undefined;
  const runtime = politeness
    ? new WebRuntime({
        politeness,
        cache,
        fetchImpl,
        allowPrivateHosts: options.config.allowPrivateHosts,
        resolve: options.resolve,
        timeoutSeconds: options.config.timeoutSeconds,
        maxBytes: options.config.maxBytes,
        browser: renderPage ? browserTransport(renderPage) : undefined,
      })
    : undefined;
  const sessionId = options.sessionId ?? "web-fetch";
  const loadPageBound: LoadPage = (url: string, loadOptions: LoadPageOptions = {}) =>
    runtime
      ? runtimePage(runtime, sessionId, url, loadOptions, signal)
      : loadPage(url, {
          timeoutSeconds: options.config.timeoutSeconds,
          maxBytes: options.config.maxBytes,
          allowPrivateHosts: options.config.allowPrivateHosts,
          fetch: fetchImpl,
          resolve: options.resolve,
          politeness,
          cache,
          ...loadOptions,
          signal: loadOptions.signal ?? signal,
        });

  return {
    timeoutMs: options.config.timeoutSeconds * 1000,
    signal,
    config: options.config,
    fetch: fetchImpl,
    loadPage: loadPageBound,
    resolve: options.resolve,
    cacheDir: options.cacheDir,
    exec: options.exec,
    renderPage,
    cookiesFor,
  };
}

const defaultBrowserRenderer: BrowserRendererFactory = (request) => createBrowserRenderer(request);

/** Render through the shared runtime and map its result to the pipeline shape. */
async function runtimePage(
  runtime: WebRuntime,
  sessionId: string,
  url: string,
  loadOptions: LoadPageOptions,
  signal: AbortSignal,
): Promise<import("./types").LoadPageResult> {
  const result = await runtime.request({
    url,
    purpose: "fetch",
    sessionId,
    method: (loadOptions.method as "GET" | "HEAD" | "POST" | undefined) ?? "GET",
    headers: loadOptions.headers,
    body: loadOptions.body,
    signal: loadOptions.signal ?? signal,
  });
  return {
    content: result.body ?? "",
    contentType: result.contentType ?? "",
    finalUrl: result.url,
    ok: isUsable(result),
    status: result.status || undefined,
    truncated: result.truncated,
    error: result.reason,
    notes: result.notes,
    retryAfterMs: result.retryAfterMs,
    outcome: result.outcome,
    challenge: result.challenge,
    cache: result.cache,
    limiter: result.limiter,
  };
}

/**
 * Outcomes that carry a body the pipeline may still shape. A challenge, a
 * robots refusal, a throttle, and a hard block never do.
 */
function isUsable(result: WebResult): boolean {
  return (
    result.outcome === "ok" ||
    result.outcome === "js-shell" ||
    result.outcome === "quality-fail" ||
    result.outcome === "consent"
  );
}

/** Browser tier transport: render the page and classify the live document. */
function browserTransport(renderPage: BrowserRenderer): BrowserTransport {
  return async (request, call) => {
    const rendered = await renderPage(request.url, { signal: call.signal });
    const classification = classifyResponse({
      status: rendered.status,
      url: rendered.finalUrl,
      body: rendered.html,
      contentType: "text/html",
    });
    return {
      url: rendered.finalUrl,
      status: rendered.status,
      outcome: classification.outcome,
      tier: call.tier,
      transport: "browser",
      contentType: "text/html",
      body: rendered.html,
      challenge: classification.challenge,
      reason: classification.reason,
    };
  };
}

/**
 * Build the renderer on first use, so a fetch that never reaches the browser
 * backend (JSON, feeds, raw, or a site handler) skips browser detection and
 * launch entirely.
 */
function lazyBrowserRenderer(
  create: BrowserRendererFactory,
  request: BrowserRenderRequest,
): BrowserRenderer | undefined {
  if (!request.config?.enabled) return undefined;
  let pending: Promise<BrowserRenderer | undefined> | undefined;
  return async (url, renderOptions) => {
    pending ??= create(request);
    const renderer = await pending;
    if (!renderer) throw new Error("No browser available for rendering");
    return renderer(url, renderOptions);
  };
}
