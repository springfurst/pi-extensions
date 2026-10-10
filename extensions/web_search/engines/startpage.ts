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
import { classifyProviderHttpError, fetchPage, type LoadedPage } from "./http";

const STARTPAGE_HOME_URL = "https://www.startpage.com/";
const STARTPAGE_SEARCH_URL = "https://www.startpage.com/sp/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

const RECENCY_TO_STARTPAGE_WITH_DATE: Record<NonNullable<EngineSearchParams["recency"]>, string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

/** True when Startpage answered with its CAPTCHA/error shell instead of results. */
export function isChallengeResponse(page: LoadedPage): boolean {
  if (/\/(?:errors|captcha)\//.test(page.url) || page.url.includes("/sp/captcha")) return true;
  return page.html.includes("component---src-pages-captcha") || page.html.includes("/sp/captcha");
}

/** Lift the hidden inputs from the homepage's `/sp/search` form. */
export function parseSearchFormInputs(html: string): Record<string, string> | undefined {
  const document = parseDocument(html);
  const form = document.querySelector('form[action="/sp/search"]');
  if (!form) return undefined;
  const inputs: Record<string, string> = {};
  for (const input of Array.from(form.querySelectorAll('input[type="hidden"]'))) {
    const name = input.getAttribute("name");
    if (name) inputs[name] = input.getAttribute("value") ?? "";
  }
  return inputs.sc ? inputs : undefined;
}

function sanitizeResultUrl(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  let url: URL;
  try {
    url = new URL(href, STARTPAGE_HOME_URL);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "startpage.com" || url.hostname.endsWith(".startpage.com")) return undefined;
  return url.href;
}

/** Walk the server-rendered Startpage results in document order. */
export function parseHtmlResults(
  html: string,
): Array<{ title: string; url: string; snippet?: string }> {
  const document = parseDocument(html);
  const results: Array<{ title: string; url: string; snippet?: string }> = [];
  for (const block of Array.from(document.querySelectorAll("div.result"))) {
    const anchor = block.querySelector("a.result-link");
    if (!anchor) continue;
    const url = sanitizeResultUrl(anchor.getAttribute("href"));
    if (!url) continue;
    const title = normalizeSearchText(
      anchor.querySelector("h2, h3")?.textContent ?? anchor.textContent,
    );
    if (!title) continue;
    const snippet = normalizeSearchText(block.querySelector("p.description")?.textContent);
    results.push({ title, url, snippet: snippet || undefined });
  }
  return results;
}

async function fetchFormInputs(
  params: EngineSearchParams,
): Promise<Record<string, string> | undefined> {
  try {
    const page = await fetchPage(STARTPAGE_HOME_URL, {
      fetch: params.fetch,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
    });
    if (page.status < 200 || page.status >= 300 || isChallengeResponse(page)) return undefined;
    return parseSearchFormInputs(page.html);
  } catch (error) {
    if (params.signal?.aborted) throw error;
    return undefined;
  }
}

async function callStartpageHtml(params: EngineSearchParams): Promise<string> {
  const withDate = params.recency ? RECENCY_TO_STARTPAGE_WITH_DATE[params.recency] : undefined;
  const query = formatScraperQuery(params.query, params.parsedQuery);
  const formInputs = await fetchFormInputs(params);

  let page: LoadedPage;
  if (formInputs) {
    const form = new URLSearchParams(formInputs);
    form.set("query", query);
    if (withDate) form.set("with_date", withDate);
    page = await fetchPage(STARTPAGE_SEARCH_URL, {
      fetch: params.fetch,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      referer: STARTPAGE_HOME_URL,
      method: "POST",
      body: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } else {
    const url = new URL(STARTPAGE_SEARCH_URL);
    url.searchParams.set("query", query);
    if (withDate) url.searchParams.set("with_date", withDate);
    page = await fetchPage(url.href, {
      fetch: params.fetch,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      referer: STARTPAGE_HOME_URL,
    });
  }

  if (isChallengeResponse(page)) {
    throw new SearchProviderError(
      "startpage",
      "Startpage blocked the request with a CAPTCHA challenge. Startpage rate-limits automated searches from datacenter IPs.",
      429,
    );
  }
  if (page.status < 200 || page.status >= 300) {
    const classified = classifyProviderHttpError("startpage", page.status, page.html);
    if (classified) throw classified;
    throw new SearchProviderError(
      "startpage",
      `Startpage HTML error (${page.status})`,
      page.status,
    );
  }
  return page.html;
}

/** Execute a Startpage search via the homepage-token form flow. */
export async function searchStartpage(params: EngineSearchParams): Promise<SearchResponse> {
  const numResults = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const html = await callStartpageHtml(params);
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  for (const result of parseHtmlResults(html)) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    sources.push({ title: result.title, url: result.url, snippet: result.snippet });
    if (sources.length >= numResults) break;
  }
  return { provider: "startpage", sources };
}

export const startpageEngine: SearchEngine = {
  id: "startpage",
  label: SEARCH_ENGINE_LABELS.startpage,
  search: searchStartpage,
};
