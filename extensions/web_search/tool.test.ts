import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserRenderer } from "../../lib/browser";
import { htmlFetch } from "./__fixtures__/search";
import { engineCooldown, executeWebSearch, searchCache, type WebSearchToolContext } from "./tool";

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
});
