import { describe, expect, it } from "vitest";
import { formatBytes, stripPageHeader } from "./tool-helpers";
import type { NetworkEntry } from "./types";
import { compactNetworkUrl, matchesNetworkPattern, networkLine, networkSummary } from "./network";

function entry(overrides: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    id: "r12",
    timestamp: new Date(0).toISOString(),
    method: "GET",
    url: "https://app.example.com/api/items?page=2",
    resourceType: "xhr",
    status: 200,
    statusText: "OK",
    mimeType: "application/json; charset=utf-8",
    size: 1400,
    durationMs: 12,
    startedAt: 0,
    ...overrides,
  };
}

describe("network output", () => {
  it("compacts same-origin and cross-origin URLs", () => {
    expect(
      compactNetworkUrl("https://app.example.com/api/items?page=2", "https://app.example.com/"),
    ).toBe("/api/items?page=2");
    expect(compactNetworkUrl("https://cdn.example.com/app.js", "https://app.example.com/")).toBe(
      "cdn.example.com/app.js",
    );
    expect(compactNetworkUrl("data:text/plain,hello", "https://app.example.com/")).toBe(
      "data:text/plain,hello",
    );
  });

  it("formats byte counts", () => {
    expect(formatBytes(42)).toBe("42B");
    expect(formatBytes(2048)).toBe("2.0KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0MB");
  });

  it("renders one summary line per request", () => {
    expect(networkLine(entry(), "https://app.example.com/")).toBe(
      "r12 200 GET /api/items?page=2 · xhr · application/json · 12ms · 1.4KB",
    );
  });

  it("counts ok, failed, and pending requests", () => {
    const summary = networkSummary([
      entry(),
      entry({ id: "r13", status: 500, failed: "net::ERR_FAILED" }),
      entry({ id: "r14", status: undefined, failed: undefined }),
    ]);
    expect(summary).toContain("3 requests");
    expect(summary).toContain("1 ok");
    expect(summary).toContain("1 failed");
    expect(summary).toContain("1 pending");
  });

  it("matches response patterns as globs or substrings", () => {
    expect(matchesNetworkPattern("/api/items", "https://app.example.com/api/items?page=2")).toBe(
      true,
    );
    expect(matchesNetworkPattern("*/api/*", "https://app.example.com/api/items")).toBe(true);
    expect(matchesNetworkPattern("*/api/*", "https://app.example.com/static/app.js")).toBe(false);
  });

  it("removes a leading page header from a step result", () => {
    expect(stripPageHeader('Tab 2 · https://example.com · "Home"\nClicked ref e1.')).toBe(
      "Clicked ref e1.",
    );
    expect(stripPageHeader("Clicked ref e1.")).toBe("Clicked ref e1.");
  });
});
