import type { JsonValue } from "@earendil-works/pi-ai";
import { createBrowserRenderer, type BrowserRenderer } from "../../lib/browser";
import { loadConfig } from "../../lib/config";
import { aggregateSearch, type SearchFailure } from "./aggregate";
import { CHALLENGE_COOLDOWN_MS, EngineCooldown, SearchCache, cacheKey } from "./cache";
import {
  ENGINES,
  ENGINE_PRIORITY,
  engineRequiresBrowser,
  isEngineId,
  resolveEngines,
} from "./engines";
import { formatForLLM } from "./format";
import { applyQueryConstraints, parseSearchQuery } from "./query";
import {
  SearchProviderError,
  formatSearchProviderFailures,
  type EngineSearchParams,
  type FetchImpl,
  type Recency,
  type SearchResponse,
  type SearchSource,
} from "./types";
import { clampNumResults } from "./utils";

export interface WebSearchParams {
  query: string;
  recency?: Recency;
  limit?: number;
}

export interface WebSearchToolContext {
  cwd: string;
  agentDir: string;
  trusted: boolean;
  signal?: AbortSignal;
  fetch?: FetchImpl;
  /** Optional browser renderer; when omitted one is built for browser-backed engines. */
  renderPage?: BrowserRenderer;
}

export interface StructuredSource {
  title: string;
  url: string;
  snippet?: string;
}

/** The framework's JSON value type used for structured output. */
type StructuredContent = JsonValue;

export interface WebSearchDetails {
  query: string;
  provider: string;
  engines: string[];
  notes: string[];
  error?: string;
}

export interface WebSearchToolResult {
  content: [{ type: "text"; text: string }];
  structuredContent: StructuredContent;
  details: WebSearchDetails;
  isError?: boolean;
}

/** Process-wide result cache and challenge cooldowns. */
export const searchCache = new SearchCache();
export const engineCooldown = new EngineCooldown();

function toStructured(sources: readonly SearchSource[]): StructuredContent {
  return sources.map((source) => {
    const item: Record<string, JsonValue> = { title: source.title, url: source.url };
    if (source.snippet !== undefined) item.snippet = source.snippet;
    return item;
  });
}

function isChallenge(error: unknown): boolean {
  return error instanceof SearchProviderError && error.status === 429;
}

function okResult(
  query: string,
  response: SearchResponse,
  notes: string[],
  engines: string[],
): WebSearchToolResult {
  return {
    content: [{ type: "text", text: formatForLLM(response, notes) }],
    structuredContent: toStructured(response.sources),
    details: { query, provider: response.provider, engines, notes },
  };
}

function errorResult(query: string, message: string, engines: string[]): WebSearchToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    structuredContent: [],
    details: { query, provider: "none", engines, notes: [], error: message },
    isError: true,
  };
}

/** Search the web across the configured keyless engines. Shared by the tool entry and tests. */
export async function executeWebSearch(
  params: WebSearchParams,
  toolCtx: WebSearchToolContext,
): Promise<WebSearchToolResult> {
  const config = loadConfig(toolCtx.cwd, {
    agentDir: toolCtx.agentDir,
    projectTrusted: toolCtx.trusted,
  });
  const fetchImpl = toolCtx.fetch ?? fetch;
  const limit = clampNumResults(params.limit ?? config.search.limit, config.search.limit, 30);
  const parsedQuery = parseSearchQuery(params.query);

  const requested = config.search.provider ? [config.search.provider] : config.search.engines;
  const wantsBrowser = requested.some((id) => isEngineId(id) && engineRequiresBrowser(id));
  const renderPage = wantsBrowser
    ? (toolCtx.renderPage ?? (await createBrowserRenderer({ config: config.browser })))
    : undefined;
  const engineIds = requested
    .filter((id) => isEngineId(id))
    .filter((id) => id !== "searxng" || config.searxng.endpoint !== undefined)
    .filter((id) => !engineRequiresBrowser(id) || renderPage !== undefined);
  if (engineIds.length === 0) {
    const browserEnginesOnly =
      requested.length > 0 &&
      renderPage === undefined &&
      requested.every((id) => isEngineId(id) && engineRequiresBrowser(id));
    const message = config.search.provider
      ? `Search provider "${config.search.provider}" is unavailable.`
      : browserEnginesOnly
        ? "The configured browser search engines are unavailable because no browser resolved."
        : "No search engines are configured.";
    return errorResult(params.query, message, []);
  }

  const engineParams: EngineSearchParams = {
    query: params.query,
    parsedQuery,
    recency: params.recency,
    limit,
    signal: toolCtx.signal,
    timeoutMs: config.search.timeoutSeconds * 1000,
    fetch: fetchImpl,
    searxng: config.searxng,
    renderPage,
  };

  const key = cacheKey(engineIds, params.query, params.recency, limit);
  const cached = searchCache.get(key);
  if (cached) {
    return okResult(
      params.query,
      cached,
      [],
      cached.provider === "public" ? engineIds : [cached.provider],
    );
  }

  const available = engineIds.filter((id) => !engineCooldown.isCoolingDown(id));
  const engines = resolveEngines(available.length > 0 ? available : engineIds);

  let response: SearchResponse | undefined;
  let failures: SearchFailure[] = [];
  let enginesUsed: string[] = [];

  if (config.search.aggregate && engines.length > 1) {
    try {
      const result = await aggregateSearch({ engines, params: engineParams });
      response = result.response;
      failures = result.failures;
      enginesUsed = result.enginesUsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(params.query, message, engineIds);
    }
  } else {
    // Sequential fallback in priority order.
    const ordered = ENGINE_PRIORITY.map((id) => engines.find((engine) => engine.id === id)).filter(
      (engine): engine is NonNullable<typeof engine> => engine !== undefined,
    );
    for (const engine of ordered) {
      try {
        response = await engine.search(engineParams);
        enginesUsed = [engine.id];
        break;
      } catch (error) {
        failures.push({ provider: { id: engine.id, label: engine.label }, error });
      }
    }
    if (!response) {
      const message =
        failures.length > 0
          ? `All search engines failed: ${formatSearchProviderFailures(failures)}`
          : "No search engines are available.";
      return errorResult(params.query, message, engineIds);
    }
  }

  if (!response) return errorResult(params.query, "No search results were returned.", engineIds);

  const notes: string[] = [];
  for (const failure of failures) {
    if (!isChallenge(failure.error)) continue;
    engineCooldown.mark(failure.provider.id, CHALLENGE_COOLDOWN_MS);
    if (isEngineId(failure.provider.id) && engineRequiresBrowser(failure.provider.id)) {
      notes.push(`${ENGINES[failure.provider.id].label} blocked the browser with a challenge.`);
    }
  }
  if (enginesUsed.some((id) => isEngineId(id) && engineRequiresBrowser(id))) {
    notes.push("A JavaScript-rendered search page (browser) contributed results.");
  }

  if (parsedQuery.hasConstraints && response.sources.length > 0) {
    const filtered = applyQueryConstraints(response.sources, parsedQuery);
    if (filtered.sources.length !== response.sources.length) {
      response = { ...response, sources: filtered.sources };
    }
    for (const label of filtered.dropped)
      notes.push(`no results matched \`${label}\`; the constraint was relaxed`);
  }

  searchCache.set(key, response, config.search.cacheTtlSeconds);
  return okResult(params.query, response, notes, enginesUsed);
}
