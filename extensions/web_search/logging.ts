import type { EngineOutcome } from "./types";

/** Tool input parameters recorded for one `web_search` call. */
export interface SearchUsageParams {
  query: string;
  recency?: string;
  limit?: number;
}

export interface SearchUsageBodyInput {
  params: SearchUsageParams;
  provider: string;
  enginesRequested: string[];
  enginesUsed: string[];
  aggregate: boolean;
  cacheHit: boolean;
  resultCount: number;
  relaxedConstraints: string[];
  perEngine: EngineOutcome[];
  notes: string[];
}

/**
 * Build the `web_search`-specific part of a usage record. `params` (the tool
 * input) is included only when `includeArgs` is true.
 */
export function buildSearchBody(
  input: SearchUsageBodyInput,
  includeArgs: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    provider: input.provider,
    enginesRequested: input.enginesRequested,
    enginesUsed: input.enginesUsed,
    aggregate: input.aggregate,
    cacheHit: input.cacheHit,
    resultCount: input.resultCount,
    perEngine: input.perEngine,
    notes: input.notes,
  };
  if (includeArgs) body.params = input.params;
  if (input.relaxedConstraints.length > 0) body.relaxedConstraints = input.relaxedConstraints;
  return body;
}
