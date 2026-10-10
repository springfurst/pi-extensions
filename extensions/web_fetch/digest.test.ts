import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../lib/config";
import {
  buildLlmEndpointCandidates,
  parseAlternateLinks,
  parseFeedToMarkdown,
  tryMdSuffix,
} from "./digest";
import type { FetchContext, LoadPageResult } from "./types";

interface Route {
  content: string;
  contentType?: string;
  ok?: boolean;
}

function makeContext(routes: Record<string, Route>): FetchContext {
  return {
    timeoutMs: 30_000,
    config: DEFAULT_CONFIG.fetch,
    fetch,
    loadPage: async (url): Promise<LoadPageResult> => {
      const route = routes[url];
      if (!route) return { content: "", contentType: "", finalUrl: url, ok: false, status: 404 };
      return {
        content: route.content,
        contentType: route.contentType ?? "text/html",
        finalUrl: url,
        ok: route.ok ?? true,
        status: 200,
      };
    },
  };
}

describe("buildLlmEndpointCandidates", () => {
  it("lists site-root endpoints for the homepage", () => {
    expect(buildLlmEndpointCandidates("https://example.com/")).toEqual([
      "https://example.com/.well-known/llms.txt",
      "https://example.com/llms.txt",
      "https://example.com/llms.md",
    ]);
  });

  it("scopes endpoints to ancestor paths, deepest first", () => {
    expect(buildLlmEndpointCandidates("https://example.com/docs/guide/page")).toEqual([
      "https://example.com/docs/guide/llms.txt",
      "https://example.com/docs/guide/llms.md",
      "https://example.com/docs/llms.txt",
      "https://example.com/docs/llms.md",
    ]);
  });
});

describe("parseFeedToMarkdown", () => {
  it("converts RSS items", () => {
    const md = parseFeedToMarkdown(
      "<rss version='2.0'><channel><title>My Feed</title><item><title>First</title><link>https://example.com/first</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><description>Hello world</description></item></channel></rss>",
    );
    expect(md).toContain("# My Feed");
    expect(md).toContain("## First");
    expect(md).toContain("[Read more](https://example.com/first)");
  });

  it("converts Atom entries", () => {
    const md = parseFeedToMarkdown(
      "<feed xmlns='http://www.w3.org/2005/Atom'><title>Atom Feed</title><entry><title>Entry</title><link href='https://example.com/e'/><updated>2024-01-01T00:00:00Z</updated><summary>Summary text</summary></entry></feed>",
    );
    expect(md).toContain("# Atom Feed");
    expect(md).toContain("## Entry");
    expect(md).toContain("[Read more](https://example.com/e)");
  });
});

describe("parseAlternateLinks", () => {
  it("collects markdown and page-scoped feed alternates", () => {
    const html =
      "<html><head>" +
      "<link rel='alternate' type='text/markdown' href='/page.md'>" +
      "<link rel='alternate' type='application/rss+xml' href='/page/feed.xml'>" +
      "<link rel='alternate' type='application/rss+xml' href='/site/feed.xml'>" +
      "</head><body></body></html>";
    const links = parseAlternateLinks(html, "https://example.com/page");
    expect(links).toContain("/page.md");
    expect(links).toContain("/page/feed.xml");
    expect(links).not.toContain("/site/feed.xml");
  });
});

describe("tryMdSuffix", () => {
  it("returns the .md variant when it is substantial", async () => {
    const markdown = `# Title\n\n${"content ".repeat(30)}`;
    const ctx = makeContext({
      "https://example.com/doc.md": { content: markdown, contentType: "text/markdown" },
    });
    expect(await tryMdSuffix("https://example.com/doc", ctx)).toBe(markdown);
  });

  it("returns null when there is no usable variant", async () => {
    const ctx = makeContext({});
    expect(await tryMdSuffix("https://example.com/doc", ctx)).toBeNull();
  });
});
