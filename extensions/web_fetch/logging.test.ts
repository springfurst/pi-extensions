import { describe, expect, it } from "vitest";
import { buildFetchBody, classifyParser, type ParserKind } from "./logging";
import type { RenderResult } from "./types";

const result: RenderResult = {
  url: "https://example.com/page",
  finalUrl: "https://www.example.com/page",
  contentType: "text/html",
  status: 200,
  method: "readability",
  content: "body",
  fetchedAt: "2026-01-01T00:00:00.000Z",
  truncated: false,
  notes: ["Used markdown alternate"],
};

describe("classifyParser", () => {
  const cases: Array<[method: string, kind: ParserKind]> = [
    ["github-repo", "site"],
    ["gitlab-mr", "site"],
    ["npm", "site"],
    ["pypi", "site"],
    ["crates.io", "site"],
    ["wikipedia", "site"],
    ["arxiv", "site"],
    ["semantic-scholar", "site"],
    ["pubmed", "site"],
    ["rfc", "site"],
    ["docs.rs", "site"],
    ["mdn", "site"],
    ["hackernews", "site"],
    ["reddit", "site"],
    ["stackexchange", "site"],
    ["readability", "reader"],
    ["trafilatura", "reader"],
    ["lynx", "reader"],
    ["jina", "reader"],
    ["browser", "reader"],
    ["json", "format"],
    ["feed", "format"],
    ["text", "format"],
    ["alternate-markdown", "format"],
    ["md-suffix", "format"],
    ["content-negotiation", "format"],
    ["alternate-feed", "format"],
    ["llms.txt", "format"],
    ["raw", "raw"],
    ["raw-html", "raw"],
    ["failed", "error"],
    ["none", "error"],
  ];

  it.each(cases)("classifies %s as %s", (method, kind) => {
    expect(classifyParser(method)).toBe(kind);
  });

  it("reports an unknown method instead of guessing", () => {
    expect(classifyParser("brand-new-parser")).toBe("unknown");
  });
});

describe("buildFetchBody", () => {
  it("records parser resolution, status, and notes", () => {
    const body = buildFetchBody(
      { params: { url: result.url }, result, charCount: 4, truncated: false },
      true,
    );
    expect(body).toMatchObject({
      requestedUrl: "https://example.com/page",
      finalUrl: "https://www.example.com/page",
      host: "example.com",
      contentType: "text/html",
      parser: "readability",
      parserKind: "reader",
      status: 200,
      charCount: 4,
      notes: ["Used markdown alternate"],
      params: { url: "https://example.com/page" },
    });
  });

  it("omits params when includeArgs is false", () => {
    const body = buildFetchBody({ params: { url: result.url }, result, truncated: false }, false);
    expect(body.params).toBeUndefined();
    expect(body.parser).toBe("readability");
  });

  it("falls back to a failed parser when the result is absent", () => {
    const body = buildFetchBody(
      { params: { url: "https://example.com/x" }, truncated: false },
      true,
    );
    expect(body).toMatchObject({
      requestedUrl: "https://example.com/x",
      finalUrl: "https://example.com/x",
      parser: "failed",
      parserKind: "error",
      truncated: false,
    });
  });

  it("includes the selector and saved path when present", () => {
    const body = buildFetchBody(
      {
        params: { url: result.url },
        result,
        selector: ":1-2",
        savedPath: "/tmp/out.md",
        truncated: true,
        truncationBinding: "render",
      },
      true,
    );
    expect(body).toMatchObject({
      selector: ":1-2",
      savedPath: "/tmp/out.md",
      truncated: true,
      truncationBinding: "render",
    });
  });
});
