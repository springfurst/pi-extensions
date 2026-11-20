// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { fingerprintFor, navigationHeaders } from "../../../lib/browser/fingerprint";
import { readLimitedText, withHardTimeout } from "../../../lib/http";
import { classifyResponse, retryAfterFromHeaders } from "../../../lib/web/outcome";
import {
  SEARCH_ENGINE_LABELS,
  SearchProviderError,
  type FetchImpl,
  type PaceFn,
  type SearchProviderId,
} from "../types";

export { readLimitedText, withHardTimeout };

const SEARCH_PAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Navigation fingerprint for keyless engines. The engines reject non-browser
 * clients, so the page request presents one browser identity; the user agent
 * and client hints come from the same fingerprint and the platform matches the
 * host, never a hardcoded one.
 */
const SEARCH_FINGERPRINT = fingerprintFor("149.0.0.0");

/** Fresh copy of the browser navigation headers. */
export function buildBrowserNavigationHeaders(): Record<string, string> {
  return navigationHeaders(SEARCH_FINGERPRINT);
}

export interface LoadedPage {
  html: string;
  status: number;
  url: string;
  /** Delay the engine asked for, when the response carried one. */
  retryAfterMs?: number;
}

export interface FetchPageOptions {
  fetch: FetchImpl;
  /** Spend the shared per-host and global budget before the request. */
  pace?: PaceFn;
  signal?: AbortSignal;
  timeoutMs?: number;
  referer?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

/** Fetch an HTML page with browser headers and a bounded body read. */
export async function fetchPage(url: string, options: FetchPageOptions): Promise<LoadedPage> {
  await options.pace?.(url, options.signal);
  const response = await options.fetch(url, {
    method: options.method,
    body: options.body,
    headers: {
      ...buildBrowserNavigationHeaders(),
      ...(options.referer ? { Referer: options.referer, "Sec-Fetch-Site": "same-origin" } : {}),
      ...options.headers,
    },
    signal: withHardTimeout(options.signal, options.timeoutMs ?? 60_000),
  });
  const { text } = await readLimitedText(response, SEARCH_PAGE_MAX_BYTES);
  const retryAfterMs = retryAfterFromHeaders(response.headers);
  return {
    html: text,
    status: response.status,
    url: response.url || url,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

const CREDIT_BODY_PATTERN = /credits?\s*(?:exhausted|exceeded)|quota|insufficient/i;

/** Map quota and auth responses to compact, provider-tagged errors. */
/**
 * Map quota, auth, and bot-challenge responses to compact, provider-tagged
 * errors. Challenge detection is shared with the fetch transport, so a new
 * challenge family is recognized everywhere at once.
 */
export function classifyProviderHttpError(
  provider: SearchProviderId,
  status: number,
  body: string,
  retryAfterMs?: number,
): SearchProviderError | null {
  const challenge = classifyResponse({ status, body });
  if (challenge.outcome === "challenge" || status === 429 || status === 503) {
    const reason =
      challenge.outcome === "challenge"
        ? challenge.reason
        : status === 429
          ? "rate limited"
          : "service unavailable";
    return new SearchProviderError(
      provider,
      `${SEARCH_ENGINE_LABELS[provider]}: ${reason ?? "bot challenge"}`,
      status,
      { challenge: true, retryAfterMs },
    );
  }
  if (CREDIT_BODY_PATTERN.test(body)) {
    return new SearchProviderError(
      provider,
      `${SEARCH_ENGINE_LABELS[provider]}: credits exhausted`,
      status,
    );
  }
  if (status === 402)
    return new SearchProviderError(
      provider,
      `${SEARCH_ENGINE_LABELS[provider]}: 402 credits exhausted`,
      status,
    );
  if (status === 401)
    return new SearchProviderError(
      provider,
      `${SEARCH_ENGINE_LABELS[provider]}: 401 unauthorized`,
      status,
    );
  if (status === 403)
    return new SearchProviderError(
      provider,
      `${SEARCH_ENGINE_LABELS[provider]}: 403 forbidden`,
      status,
    );
  return null;
}
