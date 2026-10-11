import { describe, expect, it } from "vitest";
import { buildSearchBody } from "./logging";
import type { EngineOutcome } from "./types";

const perEngine: EngineOutcome[] = [
  {
    id: "duckduckgo",
    label: "DuckDuckGo",
    status: "ok",
    returned: 10,
    contributed: 8,
    durationMs: 120,
  },
  {
    id: "startpage",
    label: "Startpage",
    status: "error",
    returned: 0,
    contributed: 0,
    durationMs: 300,
    error: "challenge",
  },
];

const base = {
  params: { query: "example", recency: "week", limit: 10 },
  provider: "public",
  enginesRequested: ["duckduckgo", "startpage"],
  enginesUsed: ["duckduckgo"],
  aggregate: true,
  cacheHit: false,
  resultCount: 10,
  relaxedConstraints: [] as string[],
  perEngine,
  notes: ["startpage challenge"],
};

describe("buildSearchBody", () => {
  it("records provider accounting and per-engine outcomes", () => {
    const body = buildSearchBody(base, true);
    expect(body).toMatchObject({
      provider: "public",
      enginesRequested: ["duckduckgo", "startpage"],
      enginesUsed: ["duckduckgo"],
      aggregate: true,
      cacheHit: false,
      resultCount: 10,
      perEngine,
      params: { query: "example", recency: "week", limit: 10 },
    });
  });

  it("omits params when includeArgs is false", () => {
    const body = buildSearchBody(base, false);
    expect(body.params).toBeUndefined();
    expect(body.perEngine).toBe(perEngine);
  });

  it("includes relaxed constraints only when present", () => {
    expect(buildSearchBody(base, true).relaxedConstraints).toBeUndefined();
    expect(
      buildSearchBody({ ...base, relaxedConstraints: ["site:x"] }, true).relaxedConstraints,
    ).toEqual(["site:x"]);
  });
});
