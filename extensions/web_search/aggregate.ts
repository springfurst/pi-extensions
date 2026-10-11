// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { withHardTimeout } from "../../lib/http";
import {
  SearchProviderError,
  formatSearchProviderFailures,
  type EngineOutcome,
  type EngineSearchParams,
  type SearchEngine,
  type SearchResponse,
  type SearchSource,
} from "./types";

export const SOFT_DEADLINE_MS = 5_000;
export const HARD_DEADLINE_MS = 30_000;

export interface AggregateOptions {
  engines: readonly SearchEngine[];
  params: EngineSearchParams;
  softMs?: number;
  hardMs?: number;
}

export interface SearchFailure {
  provider: { id: string; label: string };
  error: unknown;
}

export interface AggregateResult {
  response: SearchResponse;
  failures: SearchFailure[];
  enginesUsed: string[];
  outcomes: EngineOutcome[];
}

/** All-engines-failed error carrying the per-engine accounting for logging. */
export class AggregateFailureError extends SearchProviderError {
  constructor(
    message: string,
    public readonly outcomes: EngineOutcome[],
  ) {
    super("public", message, 503);
    this.name = "AggregateFailureError";
  }
}

interface MergedSource {
  source: SearchSource;
  engines: number;
  bestRank: number;
  order: number;
}

/**
 * Canonical dedup key: case-normalized host without `www.`, path without a
 * trailing slash, query preserved, fragment dropped.
 */
export function dedupKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return `${host}${path}${url.search}`;
  } catch {
    return rawUrl;
  }
}

function mergeSources(merged: Map<string, MergedSource>, sources: readonly SearchSource[]): void {
  for (const [rank, source] of sources.entries()) {
    const key = dedupKey(source.url);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { source: { ...source }, engines: 1, bestRank: rank, order: merged.size });
      continue;
    }
    existing.engines += 1;
    if (rank < existing.bestRank) {
      existing.bestRank = rank;
      existing.source.title = source.title;
      existing.source.url = source.url;
    }
    if (source.snippet && source.snippet.length > (existing.source.snippet?.length ?? 0)) {
      existing.source.snippet = source.snippet;
    }
    existing.source.publishedDate ??= source.publishedDate;
    existing.source.ageSeconds ??= source.ageSeconds;
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fan out across engines in parallel and consolidate by cross-engine consensus,
 * then best per-engine rank, then insertion order. Races a soft deadline
 * (return once at least one engine succeeded) and a hard deadline; stragglers
 * are aborted afterward. Individual engine failures are tolerated; the call
 * throws only when every engine fails.
 */
export async function aggregateSearch(options: AggregateOptions): Promise<AggregateResult> {
  const { engines, params } = options;
  const softMs = options.softMs ?? SOFT_DEADLINE_MS;
  const hardMs = options.hardMs ?? HARD_DEADLINE_MS;

  const straggler = new AbortController();
  const signal = AbortSignal.any([
    withHardTimeout(params.signal, params.timeoutMs),
    straggler.signal,
  ]);

  const responses: Array<SearchResponse | undefined> = new Array(engines.length);
  const errors: Array<unknown> = new Array(engines.length);
  const durations: number[] = new Array(engines.length).fill(0);
  const failures: SearchFailure[] = [];
  const enginesUsed: string[] = [];
  let resolveFirstSuccess: () => void = () => {};
  const firstSuccess = new Promise<void>((resolve) => {
    resolveFirstSuccess = resolve;
  });

  const all = Promise.all(
    engines.map(async (engine, index) => {
      const started = Date.now();
      try {
        responses[index] = await engine.search({ ...params, signal });
        enginesUsed.push(engine.id);
        resolveFirstSuccess();
      } catch (error) {
        errors[index] = error;
        failures.push({ provider: { id: engine.id, label: engine.label }, error });
      } finally {
        durations[index] = Date.now() - started;
      }
    }),
  );

  await Promise.race([all, delay(softMs)]);
  if (!responses.some((response) => response !== undefined) && failures.length < engines.length) {
    await Promise.race([all, firstSuccess, delay(Math.max(0, hardMs - softMs))]);
  }
  straggler.abort();

  const merged = new Map<string, MergedSource>();
  const contribution: number[] = new Array(engines.length).fill(0);
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    if (!response) continue;
    const before = merged.size;
    mergeSources(merged, response.sources);
    contribution[index] = merged.size - before;
  }

  const outcomes: EngineOutcome[] = engines.map((engine, index) => {
    const response = responses[index];
    const outcome: EngineOutcome = {
      id: engine.id,
      label: engine.label,
      status: response ? (response.sources.length > 0 ? "ok" : "empty") : "timeout",
      returned: response?.sources.length ?? 0,
      contributed: contribution[index] ?? 0,
      durationMs: durations[index] ?? 0,
    };
    const error = errors[index];
    if (error !== undefined) {
      outcome.status = "error";
      outcome.error = errorMessage(error);
    }
    return outcome;
  });

  if (merged.size === 0 && failures.length === engines.length) {
    throw new AggregateFailureError(
      `All search engines failed: ${formatSearchProviderFailures(failures)}`,
      outcomes,
    );
  }

  const sources = [...merged.values()]
    .sort((a, b) => b.engines - a.engines || a.bestRank - b.bestRank || a.order - b.order)
    .slice(0, params.limit)
    .map((entry) => entry.source);

  return { response: { provider: "public", sources }, failures, enginesUsed, outcomes };
}
