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

/** Cooldown steps after repeated challenges: two, five, then fifteen minutes. */
export const COOLDOWN_STEPS_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000] as const;

/** Track engines that returned a challenge so they are skipped for a cooldown. */
export class EngineCooldown {
  private readonly until = new Map<string, number>();
  private readonly steps = new Map<string, number>();

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

  /**
   * Cool an engine down for the next step in the ladder, or for the delay the
   * engine asked for when that is longer. Returns the duration applied.
   */
  mark(engine: string, options: { retryAfterMs?: number } = {}): number {
    const step = Math.min(this.steps.get(engine) ?? 0, COOLDOWN_STEPS_MS.length - 1);
    const duration = Math.max(COOLDOWN_STEPS_MS[step]!, Math.round(options.retryAfterMs ?? 0));
    this.until.set(engine, this.now() + duration);
    this.steps.set(engine, step + 1);
    return duration;
  }

  /** Clear the ladder for an engine that answered, so the next block starts low. */
  succeeded(engine: string): void {
    this.steps.delete(engine);
  }

  /** Milliseconds left in an engine's cooldown, or zero. */
  remainingMs(engine: string): number {
    return Math.max(0, (this.until.get(engine) ?? 0) - this.now());
  }

  clear(): void {
    this.until.clear();
    this.steps.clear();
  }
}
