import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserRenderer } from "../../lib/browser";
import type { UsageLogger, UsageRecord } from "../../lib/logging";
import { TOOL_VERSION } from "../../lib/version";
import { htmlFetch } from "./__fixtures__/search";
import { engineCooldown, executeWebSearch, searchCache, type WebSearchToolContext } from "./tool";
import type { EngineOutcome } from "./types";

const DDG_HTML = `
<div class="result results_links web-result">
  <a class="result__a" href="https://example.com/one">One</a>
  <a class="result__snippet" href="https://example.com/one">Snippet one</a>
</div>
<div class="result results_links web-result">
  <a class="result__a" href="https://example.com/two">Two</a>
  <div class="result__snippet">Snippet two</div>
</div>
`;

const BROWSER_HTML = `
<div class="Gx5Zad">
  <a href="https://example.com/browser"><h3>Browser Result</h3></a>
  <div class="VwiC3b">From Google</div>
</div>
`;

const STARTPAGE_HTML = `
<div class="result">
  <a class="result-link" href="https://start.example/one"><h2>Start One</h2></a>
  <p class="description">Start snippet</p>
</div>
`;

const GOOGLE_POOL_HTML = `
<div class="Gx5Zad">
  <a href="https://google.example/r"><h3>Google Result</h3></a>
  <div class="VwiC3b">Google snippet</div>
</div>
`;

const ECOSIA_POOL_HTML = `
<article data-test-id="organic-result">
  <a href="https://ecosia.example/r"><h2 data-test-id="result-title">Ecosia Result</h2></a>
  <p data-test-id="web-result-description">Ecosia snippet</p>
</article>
`;

const MOJEEK_POOL_HTML = `
<ul class="results-standard">
  <li>
    <h2><a class="title" href="https://mojeek.example/r">Mojeek Result</a></h2>
    <p class="s">Mojeek snippet</p>
  </li>
</ul>
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webtools-search-"));
  searchCache.clear();
  engineCooldown.clear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  writeFileSync(join(dir, "web-tools.json"), JSON.stringify(value));
}

function context(fetchImpl: typeof fetch): WebSearchToolContext {
  return { cwd: dir, agentDir: dir, trusted: false, fetch: fetchImpl };
}

describe("executeWebSearch", () => {
  it("returns structured sources", async () => {
    writeConfig({ search: { engines: ["duckduckgo"], aggregate: false } });
    const result = await executeWebSearch(
      { query: "example" },
      context(htmlFetch([["duckduckgo.com", DDG_HTML]])),
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toHaveLength(2);
    expect(result.details.sources).toHaveLength(2);
    expect(result.content[0].text).toContain("[1] One");
  });

  it("reports a compact error when every engine fails", async () => {
    writeConfig({ search: { engines: ["duckduckgo"], aggregate: false } });
    const result = await executeWebSearch(
      { query: "example" },
      context(htmlFetch([["duckduckgo.com", '<div class="anomaly-modal"></div>']])),
    );
    expect(result.isError).toBe(true);
    expect(result.details.error).toMatch(/DuckDuckGo/);
  });

  it("relaxes constraints that would eliminate every result", async () => {
    writeConfig({ search: { engines: ["duckduckgo"], aggregate: false } });
    const result = await executeWebSearch(
      { query: "site:nonexistent.example example" },
      context(htmlFetch([["duckduckgo.com", DDG_HTML]])),
    );
    expect(result.content[0].text).toContain("constraint was relaxed");
    expect(result.structuredContent).toHaveLength(2);
  });

  it("aggregates across engines and tolerates a failing peer", async () => {
    writeConfig({ search: { engines: ["duckduckgo", "startpage"], aggregate: true } });
    const result = await executeWebSearch(
      { query: "example" },
      context(htmlFetch([["duckduckgo.com", DDG_HTML]])),
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toHaveLength(2);
  });

  it("renders an explicit message when no results are found", async () => {
    writeConfig({ search: { engines: ["duckduckgo"], aggregate: false } });
    const empty = htmlFetch([["duckduckgo.com", "<html><body>no results</body></html>"]]);
    const result = await executeWebSearch({ query: "nothing" }, context(empty));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No results found.");
  });

  it("caches identical searches", async () => {
    writeConfig({ search: { engines: ["duckduckgo"], aggregate: false } });
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return new Response(DDG_HTML, { status: 200, headers: { "Content-Type": "text/html" } });
    };
    const ctx = context(fetchImpl);
    await executeWebSearch({ query: "cache me" }, ctx);
    const first = calls;
    await executeWebSearch({ query: "cache me" }, ctx);
    expect(calls).toBe(first);
  });

  it("skips SearXNG when no endpoint is configured", async () => {
    writeConfig({ search: { engines: ["searxng"], aggregate: false } });
    const result = await executeWebSearch({ query: "x" }, context(htmlFetch([])));
    expect(result.isError).toBe(true);
  });

  it("filters browser engines when no browser resolves", async () => {
    writeConfig({ search: { engines: ["google"], aggregate: false }, browser: { enabled: false } });
    const result = await executeWebSearch({ query: "example" }, context(htmlFetch([])));
    expect(result.isError).toBe(true);
    expect(result.details.error).toMatch(/unavailable/i);
  });

  it("uses a browser engine when a renderer is injected", async () => {
    writeConfig({ search: { engines: ["google"], aggregate: false } });
    const renderPage: BrowserRenderer = async (url) => ({
      html: BROWSER_HTML,
      status: 200,
      finalUrl: url,
    });
    const result = await executeWebSearch(
      { query: "example" },
      { ...context(htmlFetch([])), renderPage },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toHaveLength(1);
    expect(result.details.engines).toEqual(["google"]);
    expect(result.details.notes.join(" ")).toMatch(/browser/i);
  });

  it("aggregates HTTP and browser engines with a fake renderer", async () => {
    writeConfig({ search: { engines: ["duckduckgo", "google"], aggregate: true } });
    const renderPage: BrowserRenderer = async (url) => ({
      html: BROWSER_HTML,
      status: 200,
      finalUrl: url,
    });
    const result = await executeWebSearch(
      { query: "example" },
      { ...context(htmlFetch([["duckduckgo.com", DDG_HTML]])), renderPage },
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toHaveLength(3);
    expect(result.details.notes.join(" ")).toMatch(/browser/i);
  });

  it("includes all three browser engines in the default pool", async () => {
    writeConfig({});
    const renderPage: BrowserRenderer = async (url) => {
      if (url.includes("google")) return { html: GOOGLE_POOL_HTML, status: 200, finalUrl: url };
      if (url.includes("ecosia")) return { html: ECOSIA_POOL_HTML, status: 200, finalUrl: url };
      if (url.includes("mojeek")) return { html: MOJEEK_POOL_HTML, status: 200, finalUrl: url };
      return { html: "", status: 404, finalUrl: url };
    };
    const result = await executeWebSearch(
      { query: "example" },
      {
        ...context(
          htmlFetch([
            ["duckduckgo.com", DDG_HTML],
            ["startpage.com", STARTPAGE_HTML],
          ]),
        ),
        renderPage,
      },
    );
    expect(result.isError).toBeFalsy();
    const urls = (result.structuredContent as Array<{ url: string }>).map((source) => source.url);
    expect(urls).toContain("https://example.com/one");
    expect(urls).toContain("https://start.example/one");
    expect(urls).toContain("https://google.example/r");
    expect(urls).toContain("https://ecosia.example/r");
    expect(urls).toContain("https://mojeek.example/r");
  });
});

describe("executeWebSearch usage logging", () => {
  function capture(): { logger: UsageLogger; events: UsageRecord[] } {
    const events: UsageRecord[] = [];
    return { events, logger: { log: (record) => events.push(record) } };
  }

  it("records per-engine outcomes for aggregation", async () => {
    writeConfig({ search: { engines: ["duckduckgo", "startpage"], aggregate: true } });
    const { logger, events } = capture();
    const result = await executeWebSearch(
      { query: "example" },
      {
        ...context(htmlFetch([["duckduckgo.com", DDG_HTML]])),
        logger,
        sessionId: "s1",
        toolCallId: "c1",
        mode: "tui",
      },
    );
    expect(result.isError).toBeFalsy();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: "web_search",
      outcome: "ok",
      provider: "public",
      sessionId: "s1",
      toolCallId: "c1",
      mode: "tui",
      toolVersion: TOOL_VERSION,
      resultCount: 2,
    });
    const perEngine = events[0]!.perEngine as EngineOutcome[];
    expect(perEngine.find((outcome) => outcome.id === "duckduckgo")).toMatchObject({
      status: "ok",
      returned: 2,
      contributed: 2,
    });
    expect(perEngine.find((outcome) => outcome.id === "startpage")).toMatchObject({
      status: "error",
    });
    expect(events[0]!.params).toMatchObject({ query: "example" });
  });

  it("records a cache hit", async () => {
    writeConfig({ search: { engines: ["duckduckgo"], aggregate: false } });
    const { logger, events } = capture();
    const ctx = { ...context(htmlFetch([["duckduckgo.com", DDG_HTML]])), logger };
    await executeWebSearch({ query: "cache me" }, ctx);
    await executeWebSearch({ query: "cache me" }, ctx);
    expect(events).toHaveLength(2);
    expect(events[0]!.cacheHit).toBe(false);
    expect(events[1]!.cacheHit).toBe(true);
    expect((events[1]!.perEngine as EngineOutcome[])[0]).toMatchObject({ status: "cached" });
  });

  it("records an all-fail error with per-engine status", async () => {
    writeConfig({ search: { engines: ["duckduckgo"], aggregate: false } });
    const { logger, events } = capture();
    const result = await executeWebSearch(
      { query: "example" },
      {
        ...context(htmlFetch([["duckduckgo.com", '<div class="anomaly-modal"></div>']])),
        logger,
      },
    );
    expect(result.isError).toBe(true);
    expect(events[0]).toMatchObject({ outcome: "error", provider: "none", resultCount: 0 });
    expect((events[0]!.perEngine as EngineOutcome[])[0]).toMatchObject({
      id: "duckduckgo",
      status: "error",
    });
  });

  it("marks a cooling-down engine in the recorded outcomes", async () => {
    writeConfig({ search: { engines: ["duckduckgo", "startpage"], aggregate: true } });
    engineCooldown.mark("duckduckgo", 60_000);
    const { logger, events } = capture();
    const result = await executeWebSearch(
      { query: "example" },
      { ...context(htmlFetch([["startpage.com", STARTPAGE_HTML]])), logger },
    );
    expect(result.isError).toBeFalsy();
    const perEngine = events[0]!.perEngine as EngineOutcome[];
    expect(perEngine.find((outcome) => outcome.id === "duckduckgo")).toMatchObject({
      status: "cooldown",
    });
  });

  it("omits search params when logging.includeArgs is false", async () => {
    writeConfig({
      search: { engines: ["duckduckgo"], aggregate: false },
      logging: { includeArgs: false },
    });
    const { logger, events } = capture();
    await executeWebSearch(
      { query: "secret query" },
      { ...context(htmlFetch([["duckduckgo.com", DDG_HTML]])), logger },
    );
    expect(events[0]!.params).toBeUndefined();
    expect(events[0]!.provider).toBe("duckduckgo");
  });

  it("writes a per-tool file when logging is enabled", async () => {
    writeConfig({
      search: { engines: ["duckduckgo"], aggregate: false },
      logging: { enabled: true },
    });
    await executeWebSearch(
      { query: "example" },
      context(htmlFetch([["duckduckgo.com", DDG_HTML]])),
    );
    const file = join(dir, "web-tools", "usage", "web_search.jsonl");
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ tool: "web_search", provider: "duckduckgo" });
  });
});
