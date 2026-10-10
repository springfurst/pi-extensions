// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { parseDocument } from "../../../lib/dom";
import { normalizeSearchText } from "../../../lib/format";
import { formatScraperQuery } from "../query";
import { clampNumResults } from "../utils";
import {
  SEARCH_ENGINE_LABELS,
  SearchProviderError,
  type EngineSearchParams,
  type SearchEngine,
  type SearchResponse,
  type SearchSource,
} from "../types";
import { loadBrowserPage, RESULT_RENDER_TIMEOUT_MS, type BrowserLoadedPage } from "./browser-page";

const ECOSIA_HOME_URL = "https://www.ecosia.org/";
const ECOSIA_SEARCH_URL = "https://www.ecosia.org/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

interface ParsedResult {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * Validate a result anchor href. Organic anchors carry the target URL
 * directly; non-http(s) links and links back to an Ecosia vertical are
 * rejected.
 */
export function resolveResultUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, ECOSIA_HOME_URL);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "ecosia.org" || url.hostname === "www.ecosia.org") return undefined;
  return url.href;
}

/** Walk Ecosia's server-rendered organic results in document order. */
export function parseHtmlResults(html: string): ParsedResult[] {
  const document = parseDocument(html);
  const results: ParsedResult[] = [];
  for (const article of Array.from(
    document.querySelectorAll('article[data-test-id="organic-result"]'),
  )) {
    const heading = article.querySelector('[data-test-id="result-title"]');
    const href = heading?.closest("a")?.getAttribute("href");
    if (!heading || !href) continue;
    const url = resolveResultUrl(href);
    if (!url) continue;
    const title = normalizeSearchText(heading.textContent);
    if (!title) continue;
    const description =
      article.querySelector('[data-test-id="web-result-description"]') ??
      article.querySelector('[data-test-id="result-description"]');
    results.push({ title, url, snippet: normalizeSearchText(description?.textContent) });
  }
  return results;
}

/**
 * True when Ecosia's Cloudflare front answered with the managed challenge
 * instead of results.
 */
export function isBlockedPage(page: BrowserLoadedPage): boolean {
  return (
    page.status === 403 ||
    page.status === 429 ||
    page.html.includes("Ecosia Firewall") ||
    page.html.includes("_cf_chl_opt") ||
    page.html.includes("/cdn-cgi/challenge-platform/") ||
    /confirm you.{0,3}re not a robot/i.test(page.html)
  );
}

/**
 * Build the Ecosia search URL. Recency is intentionally not mapped: Ecosia
 * exposes no date filter for web results and its legacy `freshness` parameter
 * is a server-side no-op, so the field must not be approximated.
 */
export function buildSearchUrl(params: EngineSearchParams): string {
  const url = new URL(ECOSIA_SEARCH_URL);
  url.searchParams.set("q", formatScraperQuery(params.query, params.parsedQuery));
  return url.href;
}

async function callEcosiaHtml(params: EngineSearchParams): Promise<string> {
  if (!params.renderPage) {
    throw new SearchProviderError(
      "ecosia",
      "Ecosia browser search is unavailable because no browser resolved.",
      503,
    );
  }

  let page: BrowserLoadedPage;
  try {
    page = await loadBrowserPage(buildSearchUrl(params), {
      renderPage: params.renderPage,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      homeUrl: ECOSIA_HOME_URL,
      readySelector: 'article[data-test-id="organic-result"]',
      readyTimeoutMs: RESULT_RENDER_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof SearchProviderError || params.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SearchProviderError("ecosia", `Ecosia search failed: ${message}`, 503);
  }

  if (isBlockedPage(page)) {
    throw new SearchProviderError(
      "ecosia",
      "Ecosia blocked the request with a Cloudflare bot challenge. Try another web search provider or retry later.",
      429,
    );
  }
  if (page.status < 200 || page.status >= 300) {
    throw new SearchProviderError("ecosia", `Ecosia HTML error (${page.status})`, page.status);
  }
  return page.html;
}

/** Execute an Ecosia web search through a headless browser. */
export async function searchEcosia(params: EngineSearchParams): Promise<SearchResponse> {
  const numResults = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const html = await callEcosiaHtml(params);
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const result of parseHtmlResults(html)) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    sources.push({ title: result.title, url: result.url, snippet: result.snippet });
    if (sources.length >= numResults) break;
  }
  return { provider: "ecosia", sources };
}

export const ecosiaEngine: SearchEngine = {
  id: "ecosia",
  label: SEARCH_ENGINE_LABELS.ecosia,
  requiresBrowser: true,
  search: searchEcosia,
};
