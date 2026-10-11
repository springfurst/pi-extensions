import type { JsonValue } from "@earendil-works/pi-ai";
import { createBrowserRenderer, type BrowserRenderer } from "../../lib/browser";
import { loadConfig } from "../../lib/config";
import { USAGE_SCHEMA_VERSION, createFileUsageLogger, type UsageLogger } from "../../lib/logging";
import { PI_VERSION, TOOL_VERSION } from "../../lib/version";
import { AggregateFailureError, aggregateSearch, type SearchFailure } from "./aggregate";
import { CHALLENGE_COOLDOWN_MS, EngineCooldown, SearchCache, cacheKey } from "./cache";
import {
  ENGINES,
  ENGINE_PRIORITY,
  engineRequiresBrowser,
  isEngineId,
  resolveEngines,
} from "./engines";
import { formatForLLM } from "./format";
import { buildSearchBody } from "./logging";
import { applyQueryConstraints, parseSearchQuery } from "./query";
import {
  SearchProviderError,
  formatSearchProviderFailures,
  type EngineOutcome,
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
  /** Usage logger override; production uses the file logger when logging is enabled. */
  logger?: UsageLogger;
  /** Session and call metadata recorded with each usage event. */
  toolCallId?: string;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  mode?: string;
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
  /** Sources for the transcript renderer; `structuredContent` is not passed to renderers. */
  sources: StructuredSource[];
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

function toStructuredSources(sources: readonly SearchSource[]): StructuredSource[] {
  return sources.map((source) => {
    const item: StructuredSource = { title: source.title, url: source.url };
    if (source.snippet !== undefined) item.snippet = source.snippet;
    return item;
  });
}

function toStructured(sources: readonly SearchSource[]): StructuredContent {
  return toStructuredSources(sources).map((source) => {
    const item: Record<string, JsonValue> = { title: source.title, url: source.url };
    if (source.snippet !== undefined) item.snippet = source.snippet;
    return item;
  });
}

function isChallenge(error: unknown): boolean {
  return error instanceof SearchProviderError && error.status === 429;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function skippedOutcome(id: string, label: string): EngineOutcome {
  return { id, label, status: "skipped", returned: 0, contributed: 0, durationMs: 0 };
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
    details: {
      query,
      provider: response.provider,
      engines,
      notes,
      sources: toStructuredSources(response.sources),
    },
  };
}

function errorResult(query: string, message: string, engines: string[]): WebSearchToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    structuredContent: [],
    details: { query, provider: "none", engines, notes: [], sources: [], error: message },
    isError: true,
  };
}

/** Search the web across the configured keyless engines. Shared by the tool entry and tests. */
export async function executeWebSearch(
  params: WebSearchParams,
  toolCtx: WebSearchToolContext,
): Promise<WebSearchToolResult> {
  const startedAt = Date.now();
  const config = loadConfig(toolCtx.cwd, {
    agentDir: toolCtx.agentDir,
    projectTrusted: toolCtx.trusted,
  });
  const logger =
    toolCtx.logger ??
    (config.logging.enabled
      ? createFileUsageLogger({
          cwd: toolCtx.cwd,
          agentDir: toolCtx.agentDir,
          tool: "web_search",
          config: config.logging,
        })
      : undefined);
  const requested = config.search.provider ? [config.search.provider] : config.search.engines;

  const logUsage = (input: {
    provider: string;
    enginesRequested: string[];
    enginesUsed: string[];
    cacheHit: boolean;
    resultCount: number;
    relaxedConstraints: string[];
    perEngine: EngineOutcome[];
    notes: string[];
    error?: unknown;
  }): void => {
    if (!logger) return;
    try {
      logger.log({
        schema: USAGE_SCHEMA_VERSION,
        timestamp: new Date().toISOString(),
        tool: "web_search",
        toolVersion: TOOL_VERSION,
        piVersion: PI_VERSION,
        sessionId: toolCtx.sessionId,
        sessionFile: toolCtx.sessionFile,
        sessionName: toolCtx.sessionName,
        toolCallId: toolCtx.toolCallId,
        cwd: toolCtx.cwd,
        mode: toolCtx.mode,
        durationMs: Date.now() - startedAt,
        outcome: input.error ? "error" : "ok",
        error: input.error ? messageOf(input.error) : undefined,
        ...buildSearchBody(
          { ...input, params, aggregate: config.search.aggregate },
          config.logging.includeArgs,
        ),
      });
    } catch {
      // Usage logging is best-effort and must never affect the tool result.
    }
  };

  try {
    const fetchImpl = toolCtx.fetch ?? fetch;
    const limit = clampNumResults(params.limit ?? config.search.limit, config.search.limit, 30);
    const parsedQuery = parseSearchQuery(params.query);

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
      logUsage({
        provider: "none",
        enginesRequested: requested,
        enginesUsed: [],
        cacheHit: false,
        resultCount: 0,
        relaxedConstraints: [],
        perEngine: [],
        notes: [],
        error: new Error(message),
      });
      return errorResult(params.query, message, []);
    }

    const outcomes = new Map<string, EngineOutcome>();
    for (const id of engineIds) {
      outcomes.set(id, skippedOutcome(id, isEngineId(id) ? ENGINES[id].label : id));
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
      for (const outcome of outcomes.values()) outcome.status = "cached";
      const cacheEngines = cached.provider === "public" ? engineIds : [cached.provider];
      logUsage({
        provider: cached.provider,
        enginesRequested: requested,
        enginesUsed: cacheEngines,
        cacheHit: true,
        resultCount: cached.sources.length,
        relaxedConstraints: [],
        perEngine: [...outcomes.values()],
        notes: [],
      });
      return okResult(params.query, cached, [], cacheEngines);
    }

    for (const id of engineIds) {
      if (engineCooldown.isCoolingDown(id)) outcomes.get(id)!.status = "cooldown";
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
        for (const outcome of result.outcomes) outcomes.set(outcome.id, outcome);
      } catch (error) {
        if (error instanceof AggregateFailureError) {
          for (const outcome of error.outcomes) outcomes.set(outcome.id, outcome);
        }
        const message = error instanceof Error ? error.message : String(error);
        logUsage({
          provider: "none",
          enginesRequested: requested,
          enginesUsed: [],
          cacheHit: false,
          resultCount: 0,
          relaxedConstraints: [],
          perEngine: [...outcomes.values()],
          notes: [],
          error,
        });
        return errorResult(params.query, message, engineIds);
      }
    } else {
      // Sequential fallback in priority order.
      const ordered = ENGINE_PRIORITY.map((id) =>
        engines.find((engine) => engine.id === id),
      ).filter((engine): engine is NonNullable<typeof engine> => engine !== undefined);
      for (const engine of ordered) {
        const started = Date.now();
        try {
          response = await engine.search(engineParams);
          enginesUsed = [engine.id];
          outcomes.set(engine.id, {
            id: engine.id,
            label: engine.label,
            status: response.sources.length > 0 ? "ok" : "empty",
            returned: response.sources.length,
            contributed: response.sources.length,
            durationMs: Date.now() - started,
          });
          break;
        } catch (error) {
          failures.push({ provider: { id: engine.id, label: engine.label }, error });
          outcomes.set(engine.id, {
            id: engine.id,
            label: engine.label,
            status: "error",
            returned: 0,
            contributed: 0,
            durationMs: Date.now() - started,
            error: messageOf(error),
          });
        }
      }
      if (!response) {
        const message =
          failures.length > 0
            ? `All search engines failed: ${formatSearchProviderFailures(failures)}`
            : "No search engines are available.";
        logUsage({
          provider: "none",
          enginesRequested: requested,
          enginesUsed: [],
          cacheHit: false,
          resultCount: 0,
          relaxedConstraints: [],
          perEngine: [...outcomes.values()],
          notes: [],
          error: new Error(message),
        });
        return errorResult(params.query, message, engineIds);
      }
    }

    if (!response) {
      const message = "No search results were returned.";
      logUsage({
        provider: "none",
        enginesRequested: requested,
        enginesUsed: [],
        cacheHit: false,
        resultCount: 0,
        relaxedConstraints: [],
        perEngine: [...outcomes.values()],
        notes: [],
        error: new Error(message),
      });
      return errorResult(params.query, message, engineIds);
    }

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

    const relaxed: string[] = [];
    if (parsedQuery.hasConstraints && response.sources.length > 0) {
      const filtered = applyQueryConstraints(response.sources, parsedQuery);
      if (filtered.sources.length !== response.sources.length) {
        response = { ...response, sources: filtered.sources };
      }
      for (const label of filtered.dropped) {
        relaxed.push(label);
        notes.push(`no results matched \`${label}\`; the constraint was relaxed`);
      }
    }

    searchCache.set(key, response, config.search.cacheTtlSeconds);
    logUsage({
      provider: response.provider,
      enginesRequested: requested,
      enginesUsed,
      cacheHit: false,
      resultCount: response.sources.length,
      relaxedConstraints: relaxed,
      perEngine: [...outcomes.values()],
      notes,
    });
    return okResult(params.query, response, notes, enginesUsed);
  } catch (error) {
    logUsage({
      provider: "none",
      enginesRequested: requested,
      enginesUsed: [],
      cacheHit: false,
      resultCount: 0,
      relaxedConstraints: [],
      perEngine: [],
      notes: [],
      error,
    });
    throw error;
  }
}
