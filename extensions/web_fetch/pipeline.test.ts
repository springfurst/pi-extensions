import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../lib/config";
import { startServer, type RequestHandler } from "./__fixtures__/test-server";
import { createFetchContext } from "./context";
import { renderUrl } from "./pipeline";

const ARTICLE = `<!doctype html><html><head><title>Test Article</title></head><body>
<article><h1>Widgets</h1>
<p>This is a reasonably long paragraph that should survive readability extraction with enough words to
clear the algorithm's character threshold by a comfortable margin for this test fixture.</p>
<p>Another paragraph with a <a href="https://example.com">link</a>.</p>
</article></body></html>`;

const MARKDOWN = "# Doc\n\n" + "word ".repeat(59) + "word";

async function render(
  handler: RequestHandler,
  path: string,
  raw = false,
  maxChars = DEFAULT_CONFIG.fetch.maxChars,
) {
  const server = await startServer(handler);
  try {
    const ctx = createFetchContext({
      config: {
        ...DEFAULT_CONFIG.fetch,
        allowPrivateHosts: true,
        externalReaders: false,
        remoteFallbacks: false,
      },
    });
    return await renderUrl(`${server.origin}${path}`, { raw, maxChars, ctx });
  } finally {
    await server.close();
  }
}

describe("renderUrl", () => {
  it("renders an article through Readability", async () => {
    const result = await render((req, res) => {
      if (req.url === "/article") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(ARTICLE);
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    }, "/article");
    expect(result.method).toBe("readability");
    expect(result.content).toContain("Widgets");
    expect(result.content).toContain("[link](https://example.com)");
  });

  it("pretty-prints JSON", async () => {
    const result = await render((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end('{"a":1,"b":[2,3]}');
    }, "/data");
    expect(result.method).toBe("json");
    expect(result.content).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  it("converts an RSS feed", async () => {
    const result = await render((_req, res) => {
      res.setHeader("Content-Type", "application/rss+xml");
      res.end(
        "<rss><channel><title>Feed</title><item><title>Post</title><link>https://example.com/p</link></item></channel></rss>",
      );
    }, "/feed");
    expect(result.method).toBe("feed");
    expect(result.content).toContain("## Post");
  });

  it("prefers a markdown alternate link", async () => {
    const result = await render((req, res) => {
      if (req.url === "/page") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<html><head><link rel="alternate" type="text/markdown" href="/page.md"></head><body>x</body></html>`,
        );
        return;
      }
      if (req.url === "/page.md") {
        res.setHeader("Content-Type", "text/markdown");
        res.end(MARKDOWN);
        return;
      }
      res.statusCode = 404;
      res.end();
    }, "/page");
    expect(result.method).toBe("alternate-markdown");
    expect(result.content).toBe(MARKDOWN);
  });

  it("finds a .md suffix variant", async () => {
    const result = await render((req, res) => {
      if (req.url === "/doc") {
        res.setHeader("Content-Type", "text/html");
        res.end("<html><body>page</body></html>");
        return;
      }
      if (req.url === "/doc.md") {
        res.setHeader("Content-Type", "text/markdown");
        res.end(MARKDOWN);
        return;
      }
      res.statusCode = 404;
      res.end();
    }, "/doc");
    expect(result.method).toBe("md-suffix");
    expect(result.content).toBe(MARKDOWN);
  });

  it("returns the verbatim body in raw mode", async () => {
    const result = await render(
      (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(ARTICLE);
      },
      "/article",
      true,
    );
    expect(result.method).toBe("raw");
    expect(result.content).toBe(ARTICLE);
  });

  it("reports a failed fetch", async () => {
    const result = await render((_req, res) => {
      res.statusCode = 404;
      res.end("missing");
    }, "/missing");
    expect(result.method).toBe("failed");
    expect(result.notes.join(" ")).toMatch(/404/);
  });
});
