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

const GOOGLE_HOME_URL = "https://www.google.com/";
const GOOGLE_SEARCH_URL = "https://www.google.com/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

const RECENCY_TO_GOOGLE_TBS: Record<NonNullable<EngineSearchParams["recency"]>, string> = {
  day: "qdr:d",
  week: "qdr:w",
  month: "qdr:m",
  year: "qdr:y",
};

const GOOGLE_SNIPPET_SELECTORS: readonly string[] = [
  "[data-sncf='1'] .VwiC3b",
  ".VwiC3b",
  ".IsZvec",
  ".BNeawe.s3v9rd",
  "[data-sncf='1']",
];

interface ParsedResult {
  title: string;
  url: string;
  snippet?: string;
}

function normalizeText(value: string | null | undefined): string {
  return normalizeSearchText(value) ?? "";
}

/**
 * Resolve a Google result href. Google wraps organic results in
 * `/url?q=<target>` redirects; anything still on google.com (vertical
 * navigation, cached links) is rejected.
 */
export function unwrapResultUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, GOOGLE_HOME_URL);
  } catch {
    return undefined;
  }

  if (
    (url.hostname === "google.com" || url.hostname === "www.google.com") &&
    url.pathname === "/url"
  ) {
    const target = url.searchParams.get("q") || url.searchParams.get("url");
    if (!target) return undefined;
    try {
      url = new URL(target);
    } catch {
      return undefined;
    }
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "google.com" || url.hostname === "www.google.com") return undefined;
  return url.href;
}

function findSnippet(heading: Element): string | undefined {
  const container =
    heading.closest(".tF2Cxc, .MjjYud, .Gx5Zad") ?? heading.parentElement?.parentElement;
  if (!container) return undefined;

  for (const selector of GOOGLE_SNIPPET_SELECTORS) {
    const text = normalizeText(container.querySelector(selector)?.textContent).replace(
      /\s*Read more$/i,
      "",
    );
    if (text) return text;
  }
  return undefined;
}

/** Walk the server-rendered Google results in document order. */
export function parseHtmlResults(html: string): ParsedResult[] {
  const document = parseDocument(html);
  const results: ParsedResult[] = [];
  for (const heading of Array.from(document.querySelectorAll("h3"))) {
    const anchor = heading.closest("a");
    const href = anchor?.getAttribute("href");
    if (!href) continue;
    const url = unwrapResultUrl(href);
    if (!url) continue;
    const title = normalizeText(heading.textContent);
    if (!title) continue;
    results.push({ title, url, snippet: findSnippet(heading) });
  }
  return results;
}

/** Build the no-JS web-results URL for a search. */
export function buildSearchUrl(params: EngineSearchParams, numResults: number): string {
  const url = new URL(GOOGLE_SEARCH_URL);
  url.searchParams.set("q", formatScraperQuery(params.query, params.parsedQuery));
  url.searchParams.set("num", String(numResults));
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", "us");
  url.searchParams.set("udm", "14");
  url.searchParams.set("pws", "0");
  const tbs = params.recency ? RECENCY_TO_GOOGLE_TBS[params.recency] : undefined;
  if (tbs) url.searchParams.set("tbs", tbs);
  return url.href;
}

/** Classify a Google page that carries no results: JS shell or traffic challenge. */
export function blockReason(page: BrowserLoadedPage): "javascript" | "traffic" | undefined {
  if (page.html.includes("/httpservice/retry/enablejs") && !/<h3\b/i.test(page.html)) {
    return "javascript";
  }
  if (
    page.status === 403 ||
    page.status === 429 ||
    page.url.includes("/sorry/") ||
    /unusual traffic|detected unusual traffic|g-recaptcha/i.test(page.html)
  ) {
    return "traffic";
  }
  return undefined;
}

async function callGoogleHtml(params: EngineSearchParams, numResults: number): Promise<string> {
  if (!params.renderPage) {
    throw new SearchProviderError(
      "google",
      "Google browser search is unavailable because no browser resolved.",
      503,
    );
  }

  const url = buildSearchUrl(params, numResults);
  let page: BrowserLoadedPage;
  try {
    page = await loadBrowserPage(url, {
      renderPage: params.renderPage,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      homeUrl: GOOGLE_HOME_URL,
      readySelector: "a h3",
      readyTimeoutMs: RESULT_RENDER_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof SearchProviderError || params.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SearchProviderError("google", `Google browser search failed: ${message}`, 503);
  }

  const blocked = blockReason(page);
  if (blocked === "traffic") {
    throw new SearchProviderError(
      "google",
      "Google blocked the browser search with an automated-traffic challenge. Try another web search provider or retry later.",
      429,
    );
  }
  if (page.status < 200 || page.status >= 300) {
    throw new SearchProviderError("google", `Google HTML error (${page.status})`, page.status);
  }
  if (blocked === "javascript") {
    throw new SearchProviderError(
      "google",
      "Google returned its JavaScript challenge instead of rendered search results.",
      429,
    );
  }
  return page.html;
}

/** Execute a Google web search through a headless browser. */
export async function searchGoogle(params: EngineSearchParams): Promise<SearchResponse> {
  const numResults = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const html = await callGoogleHtml(params, numResults);
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const result of parseHtmlResults(html)) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    sources.push({ title: result.title, url: result.url, snippet: result.snippet });
    if (sources.length >= numResults) break;
  }
  return { provider: "google", sources };
}

export const googleEngine: SearchEngine = {
  id: "google",
  label: SEARCH_ENGINE_LABELS.google,
  requiresBrowser: true,
  search: searchGoogle,
};
