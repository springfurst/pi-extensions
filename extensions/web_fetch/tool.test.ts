import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type RequestHandler } from "./__fixtures__/test-server";
import { executeWebFetch, type WebFetchParams } from "./tool";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webtools-fetch-"));
  writeFileSync(
    join(dir, "web-tools.json"),
    JSON.stringify({ fetch: { allowPrivateHosts: true, externalReaders: false } }),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(handler: RequestHandler, makeParams: (origin: string) => WebFetchParams) {
  const server = await startServer(handler);
  try {
    return await executeWebFetch(makeParams(server.origin), {
      cwd: dir,
      agentDir: dir,
      trusted: false,
    });
  } finally {
    await server.close();
  }
}

describe("executeWebFetch", () => {
  it("returns a headed markdown article", async () => {
    const result = await run(
      (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(
          "<html><head><title>T</title></head><body><article><h1>Widgets</h1><p>" +
            "A long enough paragraph to clear the readability threshold and survive extraction cleanly. ".repeat(
              3,
            ) +
            "</p></article></body></html>",
        );
      },
      (origin) => ({ url: `${origin}/article` }),
    );
    const text = result.content[0].text;
    expect(text.startsWith("URL: ")).toBe(true);
    expect(result.details.method).toBe("readability");
    expect(text).toContain("Widgets");
  });

  it("applies a line selector to the rendered body", async () => {
    const result = await run(
      (_req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end("one\ntwo\nthree\nfour");
      },
      (origin) => ({ url: `${origin}/lines:2-3` }),
    );
    expect(result.details.selector).toBe(":2-3");
    expect(result.content[0].text).toContain("\n---\n\ntwo\nthree");
    expect(result.content[0].text).not.toContain("one");
  });

  it("writes the full body to save_path", async () => {
    const savePath = join(dir, "out.txt");
    const result = await run(
      (_req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end("hello world");
      },
      (origin) => ({ url: `${origin}/text`, save_path: savePath }),
    );
    expect(result.details.savedPath).toBe(savePath);
    expect(readFileSync(savePath, "utf-8")).toBe("hello world");
  });

  it("hints when the render cap binds", async () => {
    const body = Array.from({ length: 200 }, (_v, i) => `line ${i}`).join("\n");
    const result = await run(
      (_req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end(body);
      },
      (origin) => ({ url: `${origin}/text`, max_chars: 100 }),
    );
    expect(result.details.truncationBinding).toBe("render");
    expect(result.content[0].text).toContain("fetch.maxChars");
  });

  it("hints when the model-safe limit binds", async () => {
    const body = Array.from({ length: 3000 }, (_v, i) => `line ${i}`).join("\n");
    const result = await run(
      (_req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end(body);
      },
      (origin) => ({ url: `${origin}/text` }),
    );
    expect(result.details.truncationBinding).toBe("model");
    expect(result.content[0].text).toContain("selector range");
  });
});
