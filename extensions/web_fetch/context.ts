import { createBrowserRenderer, type BrowserRenderer } from "../../lib/browser";
import type { BrowserConfig, FetchConfig } from "../../lib/config";
import { HttpCache } from "../../lib/web/cache";
import { classifyResponse } from "../../lib/web/outcome";
import { sharedPoliteness, type Politeness } from "../../lib/web/politeness";
import type { HostPolicy, PolitenessConfig } from "../../lib/web/config";
import { WebRuntime, type BrowserTransport } from "../../lib/web/runtime";
import type { WebResult } from "../../lib/web/types";
import { loadPage } from "./fetch";
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
  /** Optional headless-browser renderer, threaded through to the reader chain. */
  renderPage?: BrowserRenderer;
  /** Browser config; when set (and enabled) a renderer is created on first use. */
  browserConfig?: BrowserConfig;
  /** Renderer factory override; defaults to `createBrowserRenderer`. */
  createRenderer?: BrowserRendererFactory;
  /** Politeness policy; absent leaves requests unpaced and robots-unchecked. */
  politeness?: PolitenessConfig;
  /** Per-host overrides applied to pacing and robots handling. */
  hosts?: Record<string, HostPolicy>;
  /** Session id recorded with requests; defaults to a stable fetch id. */
  sessionId?: string;
}

/** Build a browser renderer from config; injectable so tests can observe laziness. */
export type BrowserRendererFactory = (
  config: BrowserConfig,
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
  // pacing and learned limits survive between tool calls.
  const politeness: Politeness | undefined = options.politeness
    ? sharedPoliteness({
        dir: options.cacheDir ?? "",
        politeness: options.politeness,
        hosts: options.hosts,
      })
    : undefined;
  // Conditional GETs keep a repeat fetch cheap; entries are revalidated, so a
  // stale body is never served as fresh.
  const cache = options.cacheDir ? new HttpCache({ dir: options.cacheDir }) : undefined;
  const renderPage =
    options.renderPage ??
    lazyBrowserRenderer(options.browserConfig, options.createRenderer ?? defaultBrowserRenderer);
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
  };
}

const defaultBrowserRenderer: BrowserRendererFactory = (config) =>
  createBrowserRenderer({ config });

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
  config: BrowserConfig | undefined,
  create: BrowserRendererFactory,
): BrowserRenderer | undefined {
  if (!config?.enabled) return undefined;
  let pending: Promise<BrowserRenderer | undefined> | undefined;
  return async (url, renderOptions) => {
    pending ??= create(config);
    const renderer = await pending;
    if (!renderer) throw new Error("No browser available for rendering");
    return renderer(url, renderOptions);
  };
}
