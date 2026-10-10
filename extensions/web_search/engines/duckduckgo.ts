// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { clampNumResults, dateToAgeSeconds } from "../utils";
import { decodeHtmlEntities } from "../../../lib/format";
import { formatScraperQuery, type QuerySyntax } from "../query";
import {
  SEARCH_ENGINE_LABELS,
  SearchProviderError,
  type EngineSearchParams,
  type SearchEngine,
  type SearchResponse,
  type SearchSource,
} from "../types";
import { classifyProviderHttpError, fetchPage } from "./http";

const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

const RECENCY_TO_DDG_DF: Record<NonNullable<EngineSearchParams["recency"]>, string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

interface ParsedResult {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
}

/** Decode an HTML-encoded fragment lifted from DDG markup. */
export function decodeHtmlText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve a DDG result href back to the underlying target URL. */
export function unwrapResultUrl(href: string): string | undefined {
  if (!href) return undefined;
  const decoded = href.replace(/&amp;/gi, "&");
  const wrapMatch = decoded.match(/[?&]uddg=([^&]+)/);
  if (wrapMatch) {
    try {
      return decodeURIComponent(wrapMatch[1]!);
    } catch {
      return undefined;
    }
  }
  if (decoded.startsWith("//")) return `https:${decoded}`;
  if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
  return undefined;
}

function extractPublishedDate(block: string): string | undefined {
  const extrasUrl =
    /<div\b[^>]*\bclass="[^"]*\bresult__extras__url\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(
      block,
    )?.[1];
  if (!extrasUrl) return undefined;
  for (const match of extrasUrl.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)) {
    const text = decodeHtmlText(match[1]!);
    if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}|$)/.test(text)) return text;
  }
  return undefined;
}

/** Walk the DDG results HTML and pull result blocks in document order. */
export function parseHtmlResults(html: string): ParsedResult[] {
  const results: ParsedResult[] = [];
  const blockRe =
    /<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
  const titleRe =
    /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const snippetRe =
    /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;
  for (const match of html.matchAll(blockRe)) {
    const block = match[1]!;
    const title = titleRe.exec(block);
    if (!title) continue;
    const url = unwrapResultUrl(title[1]!);
    if (!url) continue;
    const titleText = decodeHtmlText(title[2]!);
    if (!titleText) continue;
    const snippet = snippetRe.exec(block);
    results.push({
      title: titleText,
      url,
      snippet: snippet ? decodeHtmlText(snippet[1]!) || undefined : undefined,
      publishedDate: extractPublishedDate(block),
    });
  }
  return results;
}

/** Extract the hidden fields from DDG's next-page form. */
export function parseContinuationForm(html: string): URLSearchParams | undefined {
  for (const formMatch of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    const form = new URLSearchParams();
    for (const inputMatch of formMatch[1]!.matchAll(/<input\b[^>]*>/gi)) {
      const input = inputMatch[0];
      const name = /\bname\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
      const value = /\bvalue\s*=\s*(["'])(.*?)\1/i.exec(input)?.[2];
      if (name && value !== undefined) form.append(decodeHtmlText(name), decodeHtmlText(value));
    }
    if (form.has("s") && form.has("vqd")) return form;
  }
  return undefined;
}

/** True when the page is DDG's bot-challenge modal instead of results. */
export function isAnomalyResponse(html: string): boolean {
  return html.includes("anomaly-modal") || html.includes("anomaly.js");
}

/**
 * Query syntax the DDG HTML frontend parses. Date bounds are intentionally
 * off: DDG ignores them, so they are stripped and enforced by the lenient
 * post-filter instead.
 */
export const DDG_QUERY_SYNTAX: QuerySyntax = {
  phrases: true,
  negation: true,
  or: true,
  site: true,
  inUrl: true,
  inTitle: true,
  inText: true,
  filetype: true,
};

const DDG_KL_CODES = new Set([
  "xa-ar",
  "xa-en",
  "ar-es",
  "au-en",
  "at-de",
  "be-fr",
  "be-nl",
  "br-pt",
  "bg-bg",
  "ca-en",
  "ca-fr",
  "ct-ca",
  "cl-es",
  "cn-zh",
  "co-es",
  "hr-hr",
  "cz-cs",
  "dk-da",
  "ee-et",
  "fi-fi",
  "fr-fr",
  "de-de",
  "gr-el",
  "hk-tzh",
  "hu-hu",
  "in-en",
  "id-id",
  "id-en",
  "ie-en",
  "il-he",
  "it-it",
  "jp-jp",
  "kr-kr",
  "lv-lv",
  "lt-lt",
  "xl-es",
  "my-ms",
  "my-en",
  "mx-es",
  "nl-nl",
  "nz-en",
  "no-no",
  "pe-es",
  "ph-en",
  "ph-tl",
  "pl-pl",
  "pt-pt",
  "ro-ro",
  "ru-ru",
  "sg-en",
  "sk-sk",
  "sl-sl",
  "za-en",
  "es-es",
  "se-sv",
  "ch-de",
  "ch-fr",
  "ch-it",
  "tw-tzh",
  "th-th",
  "tr-tr",
  "ua-uk",
  "uk-en",
  "us-en",
  "ue-es",
  "ve-es",
  "vn-vi",
  "wt-wt",
]);

const DDG_LOCALE_ALIASES: Record<string, string> = {
  "ca-es": "ct-ca",
  "en-gb": "uk-en",
  "es-419": "xl-es",
  "es-us": "ue-es",
  "ja-jp": "jp-jp",
  "ko-kr": "kr-kr",
  "zh-hk": "hk-tzh",
  "zh-tw": "tw-tzh",
};

/** Map a parsed `lang:` locale onto a documented DDG `kl` value. */
export function localeToKl(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const locale = lang.toLowerCase().replaceAll("_", "-");
  const alias = DDG_LOCALE_ALIASES[locale];
  if (alias) return alias;
  const match = /^([a-z]{2})-([a-z]{2})$/.exec(locale);
  if (!match) return undefined;
  const candidate = `${match[2]}-${match[1]}`;
  return DDG_KL_CODES.has(candidate) ? candidate : undefined;
}

export function createDuckDuckGoForm(params: EngineSearchParams): URLSearchParams {
  const form = new URLSearchParams({
    q: formatScraperQuery(params.query, params.parsedQuery, DDG_QUERY_SYNTAX),
    kl: localeToKl(params.parsedQuery.lang) ?? "us-en",
  });
  const df = params.recency ? RECENCY_TO_DDG_DF[params.recency] : undefined;
  if (df) form.set("df", df);
  form.set("b", "");
  return form;
}

async function callDuckDuckGoHtml(
  params: EngineSearchParams,
  form: URLSearchParams,
): Promise<string> {
  const page = await fetchPage(DUCKDUCKGO_HTML_URL, {
    fetch: params.fetch,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    referer: "https://html.duckduckgo.com/",
    method: "POST",
    body: form.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (page.status < 200 || page.status >= 300) {
    const classified = classifyProviderHttpError("duckduckgo", page.status, page.html);
    if (classified) throw classified;
    throw new SearchProviderError(
      "duckduckgo",
      `DuckDuckGo HTML error (${page.status})`,
      page.status,
    );
  }
  if (isAnomalyResponse(page.html)) {
    throw new SearchProviderError(
      "duckduckgo",
      "DuckDuckGo blocked the request with a bot-detection challenge. DuckDuckGo throttles automated HTML searches from datacenter IPs.",
      429,
    );
  }
  return page.html;
}

/** Execute a DuckDuckGo search via the no-JS HTML frontend. */
export async function searchDuckDuckGo(params: EngineSearchParams): Promise<SearchResponse> {
  const numResults = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  let form: URLSearchParams | undefined = createDuckDuckGoForm(params);

  while (form && sources.length < numResults) {
    const html = await callDuckDuckGoHtml(params, form);
    const countBefore = sources.length;
    for (const result of parseHtmlResults(html)) {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      sources.push({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        publishedDate: result.publishedDate,
        ageSeconds: dateToAgeSeconds(result.publishedDate),
      });
      if (sources.length >= numResults) break;
    }
    if (sources.length === countBefore) break;
    form = parseContinuationForm(html);
  }

  return { provider: "duckduckgo", sources };
}

export const duckduckgoEngine: SearchEngine = {
  id: "duckduckgo",
  label: SEARCH_ENGINE_LABELS.duckduckgo,
  search: searchDuckDuckGo,
};
