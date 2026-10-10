// SPDX-License-Identifier: MIT
// Opt-in live-network checks for the search engines and aggregation.
// Run with `npm run test:live`; excluded from the default `npm run test`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposeSharedBrowser, resolveBrowserExecutable } from "../../lib/browser";
import {
  engineCooldown,
  executeWebSearch,
  searchCache,
  type WebSearchToolContext,
  type WebSearchToolResult,
} from "./tool";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "webtools-live-search-"));
});

afterAll(async () => {
  await disposeSharedBrowser();
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  writeFileSync(join(dir, "web-tools.json"), JSON.stringify(value));
}

function context(): WebSearchToolContext {
  return { cwd: dir, agentDir: dir, trusted: false };
}

function reset(): void {
  searchCache.clear();
  engineCooldown.clear();
}

/**
 * A browser-engine query either returns results or fails with a classified
 * challenge (external sites throttle datacenter IPs). Any other failure -- an
 * empty success, an unclassified error, or a crash -- fails the check.
 */
function expectUsableBrowserResult(result: WebSearchToolResult): void {
  if (result.isError) {
    expect(result.details.error ?? "").toMatch(/blocked|challenge|automated|timed out|failed/i);
    return;
  }
  expect(result.content[0].text.length).toBeGreaterThan(0);
}

describe("web_search live engines", () => {
  it("never returns empty output across the configured engines", async () => {
    reset();
    writeConfig({});
    const result = await executeWebSearch(
      { query: "typescript release notes", limit: 5 },
      context(),
    );
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("never returns empty output from DuckDuckGo alone", async () => {
    reset();
    writeConfig({ search: { engines: ["duckduckgo"], aggregate: false } });
    const result = await executeWebSearch(
      { query: "typescript release notes", limit: 5 },
      context(),
    );
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("never returns empty output from Startpage alone", async () => {
    reset();
    writeConfig({ search: { engines: ["startpage"], aggregate: false } });
    const result = await executeWebSearch(
      { query: "typescript release notes", limit: 5 },
      context(),
    );
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("never returns empty output for a constrained query", async () => {
    reset();
    writeConfig({});
    const result = await executeWebSearch(
      { query: "site:example.invalid nodejs", limit: 5 },
      context(),
    );
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("returns Google results or reports a challenge through a real browser", async (testCtx) => {
    const executablePath = await resolveBrowserExecutable();
    if (!executablePath) testCtx.skip();
    reset();
    writeConfig({ search: { engines: ["google"], aggregate: false } });
    const result = await executeWebSearch(
      { query: "typescript release notes", limit: 5 },
      context(),
    );
    expectUsableBrowserResult(result);
  });

  it("returns Ecosia results or reports a challenge through a real browser", async (testCtx) => {
    const executablePath = await resolveBrowserExecutable();
    if (!executablePath) testCtx.skip();
    reset();
    writeConfig({ search: { engines: ["ecosia"], aggregate: false } });
    const result = await executeWebSearch(
      { query: "typescript release notes", limit: 5 },
      context(),
    );
    expectUsableBrowserResult(result);
  });

  it("returns Mojeek results or reports a challenge through a real browser", async (testCtx) => {
    const executablePath = await resolveBrowserExecutable();
    if (!executablePath) testCtx.skip();
    reset();
    writeConfig({ search: { engines: ["mojeek"], aggregate: false } });
    const result = await executeWebSearch(
      { query: "typescript release notes", limit: 5 },
      context(),
    );
    expectUsableBrowserResult(result);
  });
});
