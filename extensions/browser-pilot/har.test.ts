import { describe, expect, it } from "vitest";
import { buildHar } from "./har";
import type { NetworkEntry } from "./types";

describe("buildHar", () => {
  it("builds HAR 1.2 entries from network records", () => {
    const entry: NetworkEntry = {
      id: "1",
      timestamp: "2026-01-01T00:00:00.000Z",
      method: "GET",
      url: "https://example.com/api?x=1",
      resourceType: "xhr",
      status: 200,
      statusText: "OK",
      mimeType: "application/json",
      size: 11,
      durationMs: 42,
      startedAt: 0,
      requestHeaders: { accept: "application/json" },
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"ok":true}',
    };
    const har = buildHar([entry]) as {
      log: {
        version: string;
        creator: { name: string; version: string };
        entries: Array<{
          request: { method: string; url: string; queryString: Array<{ name: string }> };
          response: { status: number; content: { mimeType: string; text?: string } };
          timings: { wait: number };
        }>;
      };
    };
    expect(har.log.version).toBe("1.2");
    expect(har.log.creator.name).toBe("browser-pilot");
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0].request.method).toBe("GET");
    expect(har.log.entries[0].request.queryString).toEqual([{ name: "x", value: "1" }]);
    expect(har.log.entries[0].response.status).toBe(200);
    expect(har.log.entries[0].response.content.text).toBe('{"ok":true}');
    expect(har.log.entries[0].timings.wait).toBe(42);
  });
});
