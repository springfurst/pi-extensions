import type { Recency, SearchResponse } from "./types";

/** Build the cache key for one search request. */
export function cacheKey(
  engines: readonly string[],
  query: string,
  recency: Recency | undefined,
  limit: number,
): string {
  return JSON.stringify([engines, query, recency ?? null, limit]);
}

interface CacheEntry {
  response: SearchResponse;
  expiresAt: number;
}

/** Per-process search result cache with a TTL. */
export class SearchCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  get(key: string): SearchResponse | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.response;
  }

  set(key: string, response: SearchResponse, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return;
    this.entries.set(key, { response, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Track engines that returned a challenge so they are skipped for a cooldown window. */
export class EngineCooldown {
  private readonly until = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  isCoolingDown(engine: string): boolean {
    const expiry = this.until.get(engine);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      this.until.delete(engine);
      return false;
    }
    return true;
  }

  mark(engine: string, durationMs: number): void {
    this.until.set(engine, this.now() + durationMs);
  }

  clear(): void {
    this.until.clear();
  }
}

/** Default cooldown after an engine reports a bot challenge. */
export const CHALLENGE_COOLDOWN_MS = 60_000;
