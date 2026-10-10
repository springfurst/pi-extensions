import type { SearchEngine, SearchEngineId } from "../types";
import { duckduckgoEngine } from "./duckduckgo";
import { searxngEngine } from "./searxng";
import { startpageEngine } from "./startpage";

export const ENGINES: Record<SearchEngineId, SearchEngine> = {
  duckduckgo: duckduckgoEngine,
  startpage: startpageEngine,
  searxng: searxngEngine,
};

/** Default engine priority; used as the fallback order and aggregation tiebreak. */
export const ENGINE_PRIORITY: SearchEngineId[] = ["duckduckgo", "startpage", "searxng"];

/** True when `id` names a supported engine. */
export function isEngineId(id: string): id is SearchEngineId {
  return Object.hasOwn(ENGINES, id);
}

/** Resolve an engine by id, preserving priority order when ids are unknown. */
export function resolveEngines(ids: readonly string[]): SearchEngine[] {
  const engines: SearchEngine[] = [];
  for (const id of ids) {
    if (isEngineId(id) && !engines.some((engine) => engine.id === id)) engines.push(ENGINES[id]);
  }
  return engines;
}
