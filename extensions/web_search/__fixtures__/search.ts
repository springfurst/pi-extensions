import { parseSearchQuery } from "../query";
import type { EngineSearchParams, FetchImpl, SearchEngine, SearchResponse } from "../types";

/** Build engine params with sensible test defaults. */
export function engineParams(
  overrides: Partial<EngineSearchParams> & { query: string },
): EngineSearchParams {
  return {
    query: overrides.query,
    parsedQuery: overrides.parsedQuery ?? parseSearchQuery(overrides.query),
    recency: overrides.recency,
    limit: overrides.limit ?? 10,
    signal: overrides.signal,
    timeoutMs: overrides.timeoutMs ?? 60_000,
    fetch: overrides.fetch ?? fetch,
    searxng: overrides.searxng,
    renderPage: overrides.renderPage,
  };
}

/** Build a fake engine around a fixed response or thrown error. */
export function fakeEngine(
  id: string,
  result: SearchResponse | Error | ((params: EngineSearchParams) => Promise<SearchResponse>),
): SearchEngine {
  return {
    id: id as SearchEngine["id"],
    label: id,
    async search(params): Promise<SearchResponse> {
      if (result instanceof Error) throw result;
      if (typeof result === "function") return result(params);
      return result;
    },
  };
}

/** A fetch mock that maps URLs to HTML strings. */
export function htmlFetch(routes: Array<[match: string, html: string]>, status = 200): FetchImpl {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [match, html] of routes) {
      if (url.includes(match))
        return new Response(html, { status, headers: { "Content-Type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  };
}
