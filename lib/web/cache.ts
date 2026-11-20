/**
 * A small HTTP cache with conditional revalidation.
 *
 * Entries are kept only when the server provided a validator (`ETag` or
 * `Last-Modified`) and the body fits the size cap, so a repeat request can ask
 * "has this changed?" and skip the body entirely. One JSON file per entry under
 * the cache directory; writes are atomic and failures never break a request.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { systemClock, type Clock } from "./clock";

/** Version of the persisted entry document. */
export const CACHE_SCHEMA = 1;

/** One cached response body and its validators. */
export interface CacheEntry {
  /** Request URL, used for the variant key check on load. */
  url: string;
  etag?: string;
  lastModified?: string;
  contentType: string;
  body: string;
  storedAt: number;
}

export interface HttpCacheOptions {
  /** Directory that holds the entry files. */
  dir: string;
  clock?: Clock;
  /** How long an entry may be revalidated before it is discarded. */
  ttlMs?: number;
  /** Bodies larger than this are not stored. */
  maxBodyBytes?: number;
  /** Upper bound on entry files kept on disk. */
  maxEntries?: number;
}

/** A revalidatable response cache keyed by URL and request variant. */
export class HttpCache {
  private readonly dir: string;
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private readonly maxBodyBytes: number;
  private readonly maxEntries: number;
  private readonly memory = new Map<string, CacheEntry | undefined>();

  constructor(options: HttpCacheOptions) {
    this.dir = join(options.dir, "http");
    this.clock = options.clock ?? systemClock;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
    this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 200;
  }

  /** The stored entry for a variant key, or undefined when absent or stale. */
  lookup(key: string): CacheEntry | undefined {
    const cached = this.memory.get(key);
    if (cached !== undefined) {
      return this.fresh(cached, key) ? cached : undefined;
    }
    const entry = this.read(key);
    this.memory.set(key, entry);
    return entry && this.fresh(entry, key) ? entry : undefined;
  }

  /**
   * Store a response when it carries a validator and fits the size cap.
   * Returns true when the entry was written.
   */
  store(key: string, entry: Omit<CacheEntry, "storedAt">, now = this.clock.now()): boolean {
    if (!entry.etag && !entry.lastModified) return false;
    if (Buffer.byteLength(entry.body) > this.maxBodyBytes) return false;
    const stored: CacheEntry = { ...entry, storedAt: now };
    this.memory.set(key, stored);
    this.write(key, stored);
    return true;
  }

  /** Drop one variant. */
  delete(key: string): void {
    this.memory.delete(key);
    try {
      rmSync(this.pathFor(key), { force: true });
    } catch {
      // A cache failure never affects the request.
    }
  }

  /** Drop every in-memory and on-disk entry. */
  clear(): void {
    for (const key of [...this.memory.keys()]) this.delete(key);
    this.memory.clear();
  }

  private fresh(entry: CacheEntry, key: string): boolean {
    if (this.clock.now() - entry.storedAt > this.ttlMs) {
      this.delete(key);
      return false;
    }
    return true;
  }

  private read(key: string): CacheEntry | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.pathFor(key), "utf-8"));
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const record = parsed as Record<string, unknown>;
      if (record.schema !== CACHE_SCHEMA) return undefined;
      if (record.key !== key) return undefined;
      if (typeof record.url !== "string" || typeof record.body !== "string") return undefined;
      if (typeof record.contentType !== "string") return undefined;
      if (typeof record.storedAt !== "number" || !Number.isFinite(record.storedAt))
        return undefined;
      const entry: CacheEntry = {
        url: record.url,
        contentType: record.contentType,
        body: record.body,
        storedAt: record.storedAt,
      };
      if (typeof record.etag === "string") entry.etag = record.etag;
      if (typeof record.lastModified === "string") entry.lastModified = record.lastModified;
      return entry;
    } catch {
      return undefined;
    }
  }

  private write(key: string, entry: CacheEntry): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      this.prune();
      const path = this.pathFor(key);
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ schema: CACHE_SCHEMA, key, ...entry })}\n`);
      renameSync(temporary, path);
    } catch {
      // A read-only cache directory must not break fetching.
    }
  }

  /** Drop the oldest entries when the directory grows past the cap. */
  private prune(): void {
    if (this.memory.size <= this.maxEntries) return;
    const oldest = [...this.memory.entries()]
      .filter(([, entry]) => entry !== undefined)
      .sort((left, right) => (left[1]?.storedAt ?? 0) - (right[1]?.storedAt ?? 0))
      .slice(0, Math.ceil(this.maxEntries / 4));
    for (const [key] of oldest) this.delete(key);
  }

  private pathFor(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return join(this.dir, `${digest}.json`);
  }
}
