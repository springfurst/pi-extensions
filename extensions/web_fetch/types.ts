import type { FetchConfig } from "../../lib/config";

/** One rendered URL read, after the pipeline has shaped the response. */
export interface RenderResult {
  /** The requested URL. */
  url: string;
  /** The URL after redirects. */
  finalUrl: string;
  contentType: string;
  /** Name of the pipeline stage that produced the content. */
  method: string;
  content: string;
  fetchedAt: string;
  /** True when the render cap cut the content. */
  truncated: boolean;
  notes: string[];
}

export interface LoadPageOptions {
  timeoutSeconds?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  maxBytes?: number;
  signal?: AbortSignal;
  fetch?: FetchImpl;
  allowPrivateHosts?: boolean;
  resolve?: ResolveHost;
}

export interface LoadPageResult {
  content: string;
  contentType: string;
  finalUrl: string;
  ok: boolean;
  status?: number;
  /** True when the body was cut at the byte cap. */
  truncated?: boolean;
  /** Last transport-level error when `ok` is false. */
  error?: string;
}

export type FetchImpl = typeof fetch;
/** Resolve a hostname to its addresses; injectable for tests. */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;
export type LoadPage = (url: string, options?: LoadPageOptions) => Promise<LoadPageResult>;

export interface ExecResultLike {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<ExecResultLike>;

/** Everything a pipeline stage or site-specific handler needs to fetch. */
export interface FetchContext {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly config: FetchConfig;
  readonly fetch: FetchImpl;
  readonly loadPage: LoadPage;
  readonly resolve?: ResolveHost;
  /** Bound `pi.exec`, used only for the optional `trafilatura`/`lynx` readers. */
  readonly exec?: ExecFn;
}
