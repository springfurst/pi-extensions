import { describe, expect, it } from "vitest";
import { EngineCooldown, SearchCache, cacheKey } from "./cache";
import type { SearchResponse } from "./types";

const sample: SearchResponse = { provider: "duckduckgo", sources: [] };

describe("cacheKey", () => {
  it("distinguishes engine set, query, recency, and limit", () => {
    expect(cacheKey(["a"], "q", undefined, 10)).not.toBe(cacheKey(["a"], "q", "day", 10));
    expect(cacheKey(["a"], "q", undefined, 10)).not.toBe(cacheKey(["b"], "q", undefined, 10));
  });
});

describe("SearchCache", () => {
  it("returns entries within the TTL and evicts after it", () => {
    let now = 1_000;
    const cache = new SearchCache(() => now);
    cache.set("k", sample, 60);
    expect(cache.get("k")).toBe(sample);
    now += 61_000;
    expect(cache.get("k")).toBeUndefined();
  });

  it("ignores non-positive TTLs and clears on demand", () => {
    const cache = new SearchCache();
    cache.set("k", sample, 0);
    expect(cache.get("k")).toBeUndefined();
    cache.set("k", sample, 60);
    cache.clear();
    expect(cache.get("k")).toBeUndefined();
  });
});

describe("EngineCooldown", () => {
  it("skips a marked engine until the window elapses", () => {
    let now = 0;
    const cooldown = new EngineCooldown(() => now);
    expect(cooldown.isCoolingDown("duckduckgo")).toBe(false);
    const duration = cooldown.mark("duckduckgo", { retryAfterMs: 60_000 });
    expect(duration).toBe(2 * 60_000);
    expect(cooldown.isCoolingDown("duckduckgo")).toBe(true);
    now += duration + 1;
    expect(cooldown.isCoolingDown("duckduckgo")).toBe(false);
    cooldown.mark("x", { retryAfterMs: 1_000 });
    cooldown.clear();
    expect(cooldown.isCoolingDown("x")).toBe(false);
  });

  it("escalates the cooldown ladder and resets after a success", () => {
    const now = 0;
    const cooldown = new EngineCooldown(() => now);
    expect(cooldown.mark("google")).toBe(2 * 60_000);
    expect(cooldown.mark("google")).toBe(5 * 60_000);
    expect(cooldown.mark("google")).toBe(15 * 60_000);
    expect(cooldown.mark("google")).toBe(15 * 60_000);
    cooldown.succeeded("google");
    expect(cooldown.mark("google")).toBe(2 * 60_000);
  });

  it("honors a longer Retry-After than the ladder step", () => {
    const cooldown = new EngineCooldown(() => 0);
    expect(cooldown.mark("google", { retryAfterMs: 20 * 60_000 })).toBe(20 * 60_000);
    expect(cooldown.remainingMs("google")).toBe(20 * 60_000);
  });
});
