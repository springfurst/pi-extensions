import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageLogger, UsageRecord } from "../../lib/logging";
import { TOOL_VERSION } from "../../lib/version";
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
    expect(result.content[0].text).toContain("Saved to");
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

  it("binds to the model limit when both limits cut", async () => {
    const body = Array.from({ length: 3000 }, (_v, i) => `line ${i} ${"x".repeat(24)}`).join("\n");
    const result = await run(
      (_req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end(body);
      },
      (origin) => ({ url: `${origin}/text`, max_chars: 60000 }),
    );
    expect(result.details.truncationBinding).toBe("model");
  });

  it("applies a tail selector to the uncapped body", async () => {
    const body = Array.from({ length: 200 }, (_v, i) => `line ${i}`).join("\n");
    const result = await run(
      (_req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end(body);
      },
      (origin) => ({ url: `${origin}/lines:-2`, max_chars: 50 }),
    );
    expect(result.details.selector).toBe(":-2");
    expect(result.content[0].text).toContain("line 198\nline 199");
    expect(result.content[0].text).not.toContain("line 6");
  });

  it("writes the full body to save_path beyond the render cap", async () => {
    const savePath = join(dir, "out.txt");
    const body = Array.from({ length: 200 }, (_v, i) => `line ${i}`).join("\n");
    const result = await run(
      (_req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end(body);
      },
      (origin) => ({ url: `${origin}/text`, max_chars: 50, save_path: savePath }),
    );
    expect(readFileSync(savePath, "utf-8")).toBe(body);
    expect(result.details.truncationBinding).toBe("render");
    expect(result.content[0].text).toContain(savePath);
  });

  it("reports render truncation for a small selector over a larger document", async () => {
    const body = Array.from({ length: 200 }, (_v, i) => `line ${i}`).join("\n");
    const result = await run(
      (_req, res) => {
        res.setHeader("Content-Type", "text/plain");
        res.end(body);
      },
      (origin) => ({ url: `${origin}/lines:1-2`, max_chars: 50 }),
    );
    expect(result.details.truncationBinding).toBe("render");
    expect(result.content[0].text).toContain("fetch.maxChars");
  });
});

describe("executeWebFetch usage logging", () => {
  function capture(): { logger: UsageLogger; events: UsageRecord[] } {
    const events: UsageRecord[] = [];
    return { events, logger: { log: (record) => events.push(record) } };
  }

  it("records parser, status, and session metadata", async () => {
    const { logger, events } = capture();
    const server = await startServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        "<html><head><title>T</title></head><body><article><h1>Widgets</h1><p>" +
          "A long enough paragraph to clear the readability threshold and survive extraction cleanly. ".repeat(
            3,
          ) +
          "</p></article></body></html>",
      );
    });
    try {
      const result = await executeWebFetch(
        { url: `${server.origin}/article` },
        {
          cwd: dir,
          agentDir: dir,
          trusted: false,
          logger,
          toolCallId: "call-1",
          sessionId: "session-1",
          sessionFile: "/sessions/session-1.jsonl",
          sessionName: "my session",
          mode: "tui",
        },
      );
      expect(result.details.method).toBe("readability");
    } finally {
      await server.close();
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: "web_fetch",
      outcome: "ok",
      parser: "readability",
      parserKind: "reader",
      status: 200,
      sessionId: "session-1",
      sessionFile: "/sessions/session-1.jsonl",
      sessionName: "my session",
      toolCallId: "call-1",
      mode: "tui",
      toolVersion: TOOL_VERSION,
    });
    expect(events[0]!.params).toMatchObject({ url: `${server.origin}/article` });
    expect(typeof events[0]!.durationMs).toBe("number");
  });

  it("omits params when logging.includeArgs is false", async () => {
    writeFileSync(
      join(dir, "web-tools.json"),
      JSON.stringify({
        fetch: { allowPrivateHosts: true, externalReaders: false },
        logging: { includeArgs: false },
      }),
    );
    const { logger, events } = capture();
    const server = await startServer((_req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("plain text body");
    });
    try {
      await executeWebFetch(
        { url: `${server.origin}/text` },
        { cwd: dir, agentDir: dir, trusted: false, logger },
      );
    } finally {
      await server.close();
    }
    expect(events[0]!.params).toBeUndefined();
    expect(events[0]!.parser).toBe("text");
    expect(events[0]!.parserKind).toBe("format");
  });

  it("records an HTTP failure as an error outcome with its status", async () => {
    const { logger, events } = capture();
    const server = await startServer((_req, res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    try {
      await executeWebFetch(
        { url: `${server.origin}/fail` },
        { cwd: dir, agentDir: dir, trusted: false, logger },
      );
    } finally {
      await server.close();
    }
    expect(events[0]).toMatchObject({
      outcome: "error",
      parser: "failed",
      parserKind: "error",
      status: 500,
    });
  });

  it("does not fail the call when the logger throws", async () => {
    const logger: UsageLogger = {
      log() {
        throw new Error("log sink down");
      },
    };
    const server = await startServer((_req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("hello");
    });
    try {
      const result = await executeWebFetch(
        { url: `${server.origin}/text` },
        { cwd: dir, agentDir: dir, trusted: false, logger },
      );
      expect(result.details.method).toBe("text");
    } finally {
      await server.close();
    }
  });

  it("writes a per-tool file when logging is enabled", async () => {
    writeFileSync(
      join(dir, "web-tools.json"),
      JSON.stringify({
        fetch: { allowPrivateHosts: true, externalReaders: false },
        logging: { enabled: true },
      }),
    );
    const server = await startServer((_req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("logged body");
    });
    try {
      await executeWebFetch(
        { url: `${server.origin}/text` },
        { cwd: dir, agentDir: dir, trusted: false },
      );
    } finally {
      await server.close();
    }
    const file = join(dir, "web-tools", "usage", "web_fetch.jsonl");
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ tool: "web_fetch", parser: "text" });
  });

  it("writes nothing when logging is disabled", async () => {
    const server = await startServer((_req, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.end("quiet");
    });
    try {
      await executeWebFetch(
        { url: `${server.origin}/text` },
        { cwd: dir, agentDir: dir, trusted: false },
      );
    } finally {
      await server.close();
    }
    expect(existsSync(join(dir, "web-tools"))).toBe(false);
  });
});
