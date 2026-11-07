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
      tab: 2,
      requestHeaders: { accept: "application/json", "content-type": "application/json" },
      responseHeaders: { "content-type": "application/json" },
      postData: '{"query":"x"}',
      responseBody: '{"ok":true}',
    };
    const har = buildHar([entry], {
      tabs: [
        {
          handle: 2,
          targetId: "target-2",
          url: "https://example.com/",
          title: "Example",
          current: true,
          owned: true,
          lastUsed: 0,
        },
      ],
    }) as {
      log: {
        version: string;
        creator: { name: string; version: string };
        entries: Array<{
          pageref?: string;
          request: {
            method: string;
            url: string;
            queryString: Array<{ name: string }>;
            postData?: { mimeType: string; text: string };
          };
          response: { status: number; content: { mimeType: string; text?: string } };
          timings: { wait: number };
        }>;
        pages: Array<{ id: string }>;
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
    expect(har.log.entries[0].pageref).toBe("tab-2");
    expect(har.log.entries[0].request.postData).toEqual({
      mimeType: "application/json",
      text: '{"query":"x"}',
    });
    expect(har.log.pages).toEqual([expect.objectContaining({ id: "tab-2" })]);
  });
});
