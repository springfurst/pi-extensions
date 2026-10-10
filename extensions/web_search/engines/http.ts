// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { readLimitedText, withHardTimeout } from "../../../lib/http";
import {
  SEARCH_ENGINE_LABELS,
  SearchProviderError,
  type FetchImpl,
  type SearchProviderId,
} from "../types";

export { readLimitedText, withHardTimeout };

const SEARCH_PAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Static desktop Chrome navigation fingerprint used for keyless engines. */
const CHROME_HEADERS: Record<string, string> = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "max-age=0",
  Priority: "u=0, i",
  "Sec-Ch-Ua": '"Google Chrome";v="149", "Chromium";v="149", ";Not A Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

/** Fresh copy of the browser navigation headers. */
export function buildBrowserNavigationHeaders(): Record<string, string> {
  return { ...CHROME_HEADERS };
}

export interface LoadedPage {
  html: string;
  status: number;
  url: string;
}

export interface FetchPageOptions {
  fetch: FetchImpl;
  signal?: AbortSignal;
  timeoutMs?: number;
  referer?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

/** Fetch an HTML page with browser headers and a bounded body read. */
export async function fetchPage(url: string, options: FetchPageOptions): Promise<LoadedPage> {
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
  return { html: text, status: response.status, url: response.url || url };
}

const CREDIT_BODY_PATTERN = /credits?\s*(?:exhausted|exceeded)|quota|insufficient/i;

/** Map quota and auth responses to compact, provider-tagged errors. */
export function classifyProviderHttpError(
  provider: SearchProviderId,
  status: number,
  body: string,
): SearchProviderError | null {
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
