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
    cooldown.mark("duckduckgo", 60_000);
    expect(cooldown.isCoolingDown("duckduckgo")).toBe(true);
    now += 60_001;
    expect(cooldown.isCoolingDown("duckduckgo")).toBe(false);
    cooldown.mark("x", 1000);
    cooldown.clear();
    expect(cooldown.isCoolingDown("x")).toBe(false);
  });
});
