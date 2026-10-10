// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import type { BrowserRenderer } from "../../lib/browser";
import type { SearxngConfig } from "../../lib/config";
import type { StructuredQuery } from "./query";

export type FetchImpl = typeof fetch;
export type Recency = "day" | "week" | "month" | "year";
export type SearchEngineId = "duckduckgo" | "startpage" | "searxng" | "google";
export type SearchProviderId = SearchEngineId | "public" | "none";

/** One search result. */
export interface SearchSource {
  title: string;
  url: string;
  snippet?: string;
  /** ISO date string or relative ("2d ago"). */
  publishedDate?: string;
  /** Age in seconds for consistent formatting. */
  ageSeconds?: number;
}

/** Unified response across engines. */
export interface SearchResponse {
  provider: SearchProviderId;
  sources: SearchSource[];
  /** Synthesized answer, when an engine provides one. */
  answer?: string;
  /** Follow-up suggestions, when an engine provides them. */
  relatedQuestions?: string[];
}

/** A keyless search engine. */
export interface SearchEngine {
  id: SearchEngineId;
  label: string;
  /** True when the engine needs a headless browser; skipped when none resolves. */
  requiresBrowser?: boolean;
  search(params: EngineSearchParams): Promise<SearchResponse>;
}

export interface EngineSearchParams {
  query: string;
  parsedQuery: StructuredQuery;
  recency?: Recency;
  limit: number;
  signal?: AbortSignal;
  timeoutMs: number;
  fetch: FetchImpl;
  /** SearXNG connection settings, when the engine is SearXNG. */
  searxng?: SearxngConfig;
  /** Browser renderer, when the engine needs one. */
  renderPage?: BrowserRenderer;
}

/** Provider-tagged error with an optional HTTP status. */
export class SearchProviderError extends Error {
  constructor(
    public readonly provider: SearchProviderId,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}

export const SEARCH_ENGINE_LABELS: Record<SearchProviderId, string> = {
  duckduckgo: "DuckDuckGo",
  startpage: "Startpage",
  searxng: "SearXNG",
  google: "Google",
  public: "Public Web",
  none: "None",
};

/** Default per-engine transport deadline in seconds. */
export const DEFAULT_SEARCH_TIMEOUT_SECONDS = 60;
/** Maximum configurable per-engine transport deadline in seconds. */
export const MAX_SEARCH_TIMEOUT_SECONDS = 300;

/** Format a single engine failure for the user-facing summary. */
export function formatSearchProviderFailure(
  error: unknown,
  provider: { id: string; label: string },
): string {
  if (error instanceof SearchProviderError) {
    if (error.status === 401 || error.status === 403) {
      return `${provider.label} authorization failed (${error.status}).`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return `Unknown error from ${provider.label}`;
}

/** Format ordered engine failures for the tool output. */
export function formatSearchProviderFailures(
  failures: readonly { provider: { id: string; label: string }; error: unknown }[],
): string {
  return failures
    .map(
      (failure) =>
        `${failure.provider.id}: ${formatSearchProviderFailure(failure.error, failure.provider)}`,
    )
    .join("; ");
}
