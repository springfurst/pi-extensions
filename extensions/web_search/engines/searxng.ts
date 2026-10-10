// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import type { SearxngConfig } from "../../../lib/config";
import { formatScraperQuery } from "../query";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import {
  SEARCH_ENGINE_LABELS,
  SearchProviderError,
  type EngineSearchParams,
  type SearchEngine,
  type SearchResponse,
  type SearchSource,
} from "../types";
import { classifyProviderHttpError, withHardTimeout } from "./http";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

const RECENCY_MAP: Record<NonNullable<EngineSearchParams["recency"]>, string> = {
  day: "day",
  // SearXNG only supports day/month/year, so a week window widens to month.
  week: "month",
  month: "month",
  year: "year",
};

interface SearXNGResult {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
  publishedDate?: string;
  published_date?: string;
}

interface SearXNGResponse {
  results?: SearXNGResult[];
  suggestions?: string[];
  unresponsive_engines?: Array<[string, string]>;
  answers?: unknown[];
}

interface SearXNGConfigPayload {
  engines?: Array<{ name?: string; shortcut?: string }>;
}

interface SearXNGAuth {
  type: "basic" | "bearer";
  value: string;
}

function buildBasicAuthValue(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, "utf-8").toString("base64");
}

function hasControlCharacters(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- RFC 7617 forbids C0/C1 controls in credentials.
  return /[\u0000-\u001F\u007F-\u009F]/u.test(value);
}

/** Resolve SearXNG authentication. Basic auth takes precedence over bearer tokens. */
export function findSearxngAuth(config: SearxngConfig): SearXNGAuth | null {
  if (config.basicUsername !== undefined || config.basicPassword !== undefined) {
    if (config.basicUsername === undefined || config.basicPassword === undefined) {
      throw new Error("SearXNG basic auth requires both basicUsername and basicPassword.");
    }
    if (config.basicUsername.includes(":")) {
      throw new Error("SearXNG basic auth username cannot contain ':'.");
    }
    if (hasControlCharacters(config.basicUsername) || hasControlCharacters(config.basicPassword)) {
      throw new Error("SearXNG basic auth credentials must not contain control characters.");
    }
    return {
      type: "basic",
      value: buildBasicAuthValue(config.basicUsername, config.basicPassword),
    };
  }
  return config.token ? { type: "bearer", value: config.token } : null;
}

function buildHeaders(auth: SearXNGAuth | null): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth?.type === "basic") headers.Authorization = `Basic ${auth.value}`;
  else if (auth?.type === "bearer") headers.Authorization = `Bearer ${auth.value}`;
  return headers;
}

const engineNameMapCache = new Map<string, Promise<Map<string, string> | null>>();

async function fetchEngineNameMap(
  base: string,
  auth: SearXNGAuth | null,
  params: EngineSearchParams,
): Promise<Map<string, string> | null> {
  try {
    const response = await params.fetch(`${base}/config`, {
      headers: buildHeaders(auth),
      signal: withHardTimeout(params.signal, params.timeoutMs),
    });
    if (!response.ok) return null;
    const config = (await response.json()) as SearXNGConfigPayload;
    const map = new Map<string, string>();
    for (const engine of config.engines ?? []) {
      if (!engine.name) continue;
      map.set(engine.name.toLowerCase(), engine.name);
      if (engine.shortcut) map.set(engine.shortcut.toLowerCase(), engine.name);
    }
    return map.size ? map : null;
  } catch {
    return null;
  }
}

function getEngineNameMap(
  endpoint: string,
  auth: SearXNGAuth | null,
  params: EngineSearchParams,
): Promise<Map<string, string> | null> {
  const base = endpoint.replace(/\/+$/, "");
  let cached = engineNameMapCache.get(base);
  if (!cached) {
    cached = fetchEngineNameMap(base, auth, params).then((map) => {
      if (!map) engineNameMapCache.delete(base);
      return map;
    });
    engineNameMapCache.set(base, cached);
  }
  return cached;
}

async function resolveEngineNames(
  raw: string,
  endpoint: string,
  auth: SearXNGAuth | null,
  params: EngineSearchParams,
): Promise<string | undefined> {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) return undefined;
  const map = await getEngineNameMap(endpoint, auth, params);
  if (!map) return entries.join(",");
  return entries.map((entry) => map.get(entry.toLowerCase()) ?? entry).join(",");
}

/** Strip external bang tokens that break SearXNG JSON responses. */
export function stripExternalBangs(query: string): string {
  return query
    .split(/\s+/)
    .filter((part) => !part.startsWith("!!"))
    .join(" ");
}

function extractAnswerText(answer: unknown): string | undefined {
  if (typeof answer === "string") return answer.trim() || undefined;
  if (!answer || typeof answer !== "object") return undefined;
  const record = answer as Record<string, unknown>;
  if (typeof record.answer === "string") return record.answer.trim() || undefined;
  if (Array.isArray(record.translations)) {
    const translations: string[] = [];
    for (const item of record.translations) {
      if (!item || typeof item !== "object") continue;
      const text = (item as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) translations.push(text.trim());
      if (translations.length === 3) break;
    }
    if (translations.length) return translations.join("\n");
  }
  return undefined;
}

function formatAnswers(answers: unknown[] | undefined): string | undefined {
  const texts: string[] = [];
  for (const answer of answers ?? []) {
    const text = extractAnswerText(answer);
    if (text) texts.push(text);
    if (texts.length === 3) break;
  }
  return texts.length ? texts.join("\n\n") : undefined;
}

function buildRequestUrl(
  endpoint: string,
  query: string,
  config: SearxngConfig,
  options: { recency?: EngineSearchParams["recency"]; engines?: string },
): URL {
  const url = new URL(`${endpoint.replace(/\/+$/, "")}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", "1");
  if (options.recency) url.searchParams.set("time_range", RECENCY_MAP[options.recency]);
  if (config.categories) url.searchParams.set("categories", config.categories);
  if (options.engines) url.searchParams.set("engines", options.engines);
  if (config.safesearch !== undefined)
    url.searchParams.set("safesearch", String(config.safesearch));
  if (config.language) url.searchParams.set("language", config.language);
  return url;
}

/** Execute a SearXNG search against a configured instance. */
export async function searchSearXNG(params: EngineSearchParams): Promise<SearchResponse> {
  const config = params.searxng ?? {};
  const endpoint = config.endpoint;
  if (!endpoint) {
    throw new Error("SearXNG endpoint not configured. Set searxng.endpoint or SEARXNG_ENDPOINT.");
  }
  const auth = findSearxngAuth(config);
  const limit = clampNumResults(params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);

  const parsed = params.parsedQuery;
  let language = config.language;
  if (parsed.lang) language = parsed.lang;
  const query = stripExternalBangs(formatScraperQuery(params.query, parsed));
  const engines = config.engines
    ? await resolveEngineNames(config.engines, endpoint, auth, params)
    : undefined;

  const url = buildRequestUrl(
    endpoint,
    query,
    { ...config, language },
    { recency: params.recency, engines },
  );
  const response = await params.fetch(url, {
    headers: buildHeaders(auth),
    signal: withHardTimeout(params.signal, params.timeoutMs),
  });
  if (!response.ok) {
    const errorText = await response.text();
    const classified = classifyProviderHttpError("searxng", response.status, errorText);
    if (classified) throw classified;
    throw new SearchProviderError(
      "searxng",
      `SearXNG API error (${response.status}): ${errorText}`,
      response.status,
    );
  }

  const data = (await response.json()) as SearXNGResponse;
  const sources: SearchSource[] = [];
  for (const result of data.results ?? []) {
    if (!result.url) continue;
    const publishedDate = result.publishedDate ?? result.published_date;
    sources.push({
      title: result.title ?? result.url,
      url: result.url,
      snippet: (result.content ?? result.snippet)?.trim() || undefined,
      publishedDate: publishedDate ?? undefined,
      ageSeconds: dateToAgeSeconds(publishedDate),
    });
  }

  const limitedSources = sources.slice(0, limit);
  if (limitedSources.length === 0 && data.unresponsive_engines?.length) {
    const upstreamFailures = data.unresponsive_engines
      .map(([engine, reason]) => `${engine}: ${reason}`)
      .join("; ");
    throw new SearchProviderError(
      "searxng",
      `SearXNG returned no usable results; upstream engines failed: ${upstreamFailures}`,
      503,
    );
  }

  return {
    provider: "searxng",
    answer: formatAnswers(data.answers),
    sources: limitedSources,
    relatedQuestions: data.suggestions?.length ? data.suggestions : undefined,
  };
}

export const searxngEngine: SearchEngine = {
  id: "searxng",
  label: SEARCH_ENGINE_LABELS.searxng,
  search: searchSearXNG,
};
