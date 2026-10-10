// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { parseDocument } from "../../../lib/dom";
import { normalizeSearchText } from "../../../lib/format";
import { formatScraperQuery, type QuerySyntax } from "../query";
import { clampNumResults } from "../utils";
import {
  SEARCH_ENGINE_LABELS,
  SearchProviderError,
  type EngineSearchParams,
  type SearchEngine,
  type SearchResponse,
  type SearchSource,
} from "../types";
import { loadBrowserPage, type BrowserLoadedPage } from "./browser-page";

const MOJEEK_ORIGIN = "https://www.mojeek.de";
const MOJEEK_HOME_URL = `${MOJEEK_ORIGIN}/?arc=none&lang=en&lb=en&theme=dark`;
const MOJEEK_SEARCH_URL = `${MOJEEK_ORIGIN}/search`;
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

interface ParsedResult {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * Validate a result href. Mojeek links results directly to the target site, so
 * this only filters non-HTTP schemes and intra-Mojeek navigation rows.
 */
export function normalizeResultUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, MOJEEK_HOME_URL);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (/(^|\.)mojeek\.(com|co\.uk|fr|de)$/i.test(url.hostname)) {
    return undefined;
  }
  return url.href;
}

/**
 * Pull result blocks out of a Mojeek results page in document order. Each
 * organic result is an `li` with the title in `h2 > a.title` and the preview
 * text in `p.s`; rows without a title anchor (infoboxes, suggestions) skip.
 */
export function parseHtmlResults(html: string): ParsedResult[] {
  const document = parseDocument(html);
  const results: ParsedResult[] = [];
  for (const item of Array.from(document.querySelectorAll("ul.results-standard > li"))) {
    const anchor = item.querySelector("h2 a.title") ?? item.querySelector("a.title");
    const href = anchor?.getAttribute("href");
    if (!href) continue;
    const url = normalizeResultUrl(href);
    if (!url) continue;
    const title = normalizeSearchText(anchor?.textContent);
    if (!title) continue;
    results.push({
      title,
      url,
      snippet: normalizeSearchText(item.querySelector("p.s")?.textContent),
    });
  }
  return results;
}

/**
 * Syntax re-emitted to Mojeek. Mojeek parses `site:`, quoted phrases, and `-`
 * exclusions; date bounds and `in*:` constraints are left to the pipeline's
 * lenient post-filter.
 */
const MOJEEK_QUERY_SYNTAX: QuerySyntax = { phrases: true, negation: true, site: true };

/** Build the Mojeek search URL, including the relative `since` recency filter. */
export function buildSearchUrl(params: EngineSearchParams, numResults: number): string {
  const url = new URL(MOJEEK_SEARCH_URL);
  url.searchParams.set(
    "q",
    formatScraperQuery(params.query, params.parsedQuery, MOJEEK_QUERY_SYNTAX),
  );
  url.searchParams.set("t", String(numResults));
  url.searchParams.set("arc", "none");
  url.searchParams.set("lang", "en");
  url.searchParams.set("lb", "en");
  url.searchParams.set("theme", "dark");
  if (params.recency) url.searchParams.set("since", params.recency);
  return url.href;
}

/** True when Mojeek answered with its ALTCHA or automated-queries wall. */
export function isRobotPage(page: BrowserLoadedPage): boolean {
  return (
    (page.html.includes("altcha-widget") ||
      page.html.includes("captcha-wrap") ||
      /sending automated queries/i.test(page.html)) &&
    !page.html.includes("results-standard")
  );
}

async function callMojeekHtml(params: EngineSearchParams, numResults: number): Promise<string> {
  if (!params.renderPage) {
    throw new SearchProviderError(
      "mojeek",
      "Mojeek browser search is unavailable because no browser resolved.",
      503,
    );
  }

  let page: BrowserLoadedPage;
  try {
    page = await loadBrowserPage(buildSearchUrl(params, numResults), {
      renderPage: params.renderPage,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      homeUrl: MOJEEK_HOME_URL,
      readySelector: "ul.results-standard li",
    });
  } catch (error) {
    if (error instanceof SearchProviderError || params.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SearchProviderError("mojeek", `Mojeek search failed: ${message}`, 503);
  }

  if (isRobotPage(page)) {
    throw new SearchProviderError(
      "mojeek",
      "Mojeek blocked the request with its automated-queries wall. Retry later or configure another engine.",
      429,
    );
  }
  if (page.status < 200 || page.status >= 300) {
    throw new SearchProviderError("mojeek", `Mojeek HTML error (${page.status})`, page.status);
  }
  return page.html;
}

/** Execute a Mojeek web search through a headless browser. */
export async function searchMojeek(params: EngineSearchParams): Promise<SearchResponse> {
  const numResults = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const html = await callMojeekHtml(params, numResults);
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const result of parseHtmlResults(html)) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    sources.push({ title: result.title, url: result.url, snippet: result.snippet });
    if (sources.length >= numResults) break;
  }
  return { provider: "mojeek", sources };
}

export const mojeekEngine: SearchEngine = {
  id: "mojeek",
  label: SEARCH_ENGINE_LABELS.mojeek,
  requiresBrowser: true,
  search: searchMojeek,
};
