import { createBrowserRenderer, type BrowserRenderer } from "../../lib/browser";
import type { BrowserConfig, FetchConfig } from "../../lib/config";
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
  const loadPageBound: LoadPage = (url: string, loadOptions: LoadPageOptions = {}) =>
    loadPage(url, {
      timeoutSeconds: options.config.timeoutSeconds,
      maxBytes: options.config.maxBytes,
      allowPrivateHosts: options.config.allowPrivateHosts,
      fetch: fetchImpl,
      resolve: options.resolve,
      ...loadOptions,
      signal: loadOptions.signal ?? signal,
    });

  const renderPage =
    options.renderPage ??
    lazyBrowserRenderer(options.browserConfig, options.createRenderer ?? defaultBrowserRenderer);

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
