import { describe, expect, it } from "vitest";
import { engineParams, fakeEngine } from "./__fixtures__/search";
import { aggregateSearch, dedupKey } from "./aggregate";
import type { SearchResponse } from "./types";

function response(
  provider: SearchResponse["provider"],
  sources: SearchResponse["sources"],
): SearchResponse {
  return { provider, sources };
}

describe("dedupKey", () => {
  it("normalizes host and trailing slash, keeps query, drops fragment", () => {
    expect(dedupKey("https://www.Example.com/a/")).toBe("example.com/a");
    expect(dedupKey("https://example.com/a?b=1#frag")).toBe("example.com/a?b=1");
  });
});

describe("aggregateSearch", () => {
  it("dedups and ranks by cross-engine consensus", async () => {
    const duckduckgo = fakeEngine(
      "duckduckgo",
      response("duckduckgo", [
        { title: "Shared", url: "https://www.example.com/shared/" },
        { title: "Alpha", url: "https://a.example/one" },
      ]),
    );
    const startpage = fakeEngine(
      "startpage",
      response("startpage", [
        {
          title: "Shared (sp)",
          url: "https://example.com/shared",
          snippet: "a much longer snippet",
        },
        { title: "Beta", url: "https://b.example/two" },
      ]),
    );

    const result = await aggregateSearch({
      engines: [duckduckgo, startpage],
      params: engineParams({ query: "x", limit: 10 }),
    });

    expect(result.response.sources[0]?.url).toContain("example.com/shared");
    expect(result.response.sources[0]?.snippet).toBe("a much longer snippet");
    expect(result.enginesUsed.sort()).toEqual(["duckduckgo", "startpage"]);
  });

  it("tolerates individual engine failures", async () => {
    const ok = fakeEngine(
      "duckduckgo",
      response("duckduckgo", [{ title: "A", url: "https://a.example" }]),
    );
    const bad = fakeEngine("startpage", new Error("boom"));
    const result = await aggregateSearch({
      engines: [ok, bad],
      params: engineParams({ query: "x" }),
    });
    expect(result.response.sources).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
  });

  it("throws when every engine fails", async () => {
    const bad1 = fakeEngine("duckduckgo", new Error("a"));
    const bad2 = fakeEngine("startpage", new Error("b"));
    await expect(
      aggregateSearch({ engines: [bad1, bad2], params: engineParams({ query: "x" }) }),
    ).rejects.toThrow(/All search engines failed/);
  });

  it("returns once a fast engine succeeds despite a slow peer", async () => {
    const fast = fakeEngine(
      "duckduckgo",
      response("duckduckgo", [{ title: "Fast", url: "https://fast.example" }]),
    );
    const slow = fakeEngine(
      "startpage",
      (params) =>
        new Promise<SearchResponse>((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const started = Date.now();
    const result = await aggregateSearch({
      engines: [fast, slow],
      params: engineParams({ query: "x" }),
      softMs: 20,
      hardMs: 200,
    });
    expect(result.response.sources[0]?.url).toBe("https://fast.example");
    expect(Date.now() - started).toBeLessThan(150);
  });
});
