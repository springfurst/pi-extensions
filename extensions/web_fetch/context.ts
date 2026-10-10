import type { FetchConfig } from "../../lib/config";
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
  exec?: ExecFn;
}

/**
 * Bind configuration, cancellation, and injectable transport into the context
 * pipeline stages and site handlers use.
 */
export function createFetchContext(options: CreateFetchContextOptions): FetchContext {
  const fetchImpl = options.fetch ?? fetch;
  const loadPageBound: LoadPage = (url: string, loadOptions: LoadPageOptions = {}) =>
    loadPage(url, {
      timeoutSeconds: options.config.timeoutSeconds,
      maxBytes: options.config.maxBytes,
      allowPrivateHosts: options.config.allowPrivateHosts,
      fetch: fetchImpl,
      resolve: options.resolve,
      ...loadOptions,
      signal: loadOptions.signal ?? options.signal,
    });

  return {
    timeoutMs: options.config.timeoutSeconds * 1000,
    signal: options.signal,
    config: options.config,
    fetch: fetchImpl,
    loadPage: loadPageBound,
    resolve: options.resolve,
    exec: options.exec,
  };
}
