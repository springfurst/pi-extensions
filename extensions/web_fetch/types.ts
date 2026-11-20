// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import type { BrowserRenderer } from "../../lib/browser";
import type { FetchConfig } from "../../lib/config";
import type { ResolveHost } from "../../lib/security";
import type { FetchImpl, TransferOptions, TransferResult } from "../../lib/web/transfer";

export type { FetchImpl, ResolveHost, TransferOptions, TransferResult };
export type { TransferOptions as LoadPageOptions, TransferResult as LoadPageResult };

/** One rendered URL read, after the pipeline has shaped the response. */
export interface RenderResult {
  /** The requested URL. */
  url: string;
  /** The URL after redirects. */
  finalUrl: string;
  contentType: string;
  /** HTTP status of the main response; undefined for site handlers and probes. */
  status?: number;
  /** Name of the pipeline stage that produced the content. */
  method: string;
  content: string;
  fetchedAt: string;
  /** True when the render cap cut the content. */
  truncated: boolean;
  notes: string[];
}

export type LoadPage = (url: string, options?: TransferOptions) => Promise<TransferResult>;

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
  /** Directory for opportunistic caches, such as docs.rs rustdoc JSON. */
  readonly cacheDir?: string;
  /** Bound `pi.exec`, used only for the optional `trafilatura`/`lynx` readers. */
  readonly exec?: ExecFn;
  /** Optional headless-browser renderer; when absent the browser backend is skipped. */
  readonly renderPage?: BrowserRenderer;
}
