import { describe, expect, it } from "vitest";
import { buildLlmEndpointCandidates, probe, type ProbeFetch, type ProbeOptions } from "./probes";
import type { TransferResult } from "./transfer";

interface Call {
  url: string;
  accept?: string;
  cookies?: string;
  timeoutSeconds?: number;
}

interface Route {
  content: string;
  contentType?: string;
  ok?: boolean;
}

function transport(routes: Record<string, Route | string>): {
  fetch: ProbeFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchPage: ProbeFetch = async (url, options = {}) => {
    calls.push({
      url,
      accept: options.headers?.Accept,
      cookies: options.cookies,
      timeoutSeconds: options.timeoutSeconds,
    });
    const route = routes[url];
    const content = typeof route === "string" ? route : (route?.content ?? "");
    const contentType =
      typeof route === "string" ? "text/markdown" : (route?.contentType ?? "text/markdown");
    const ok = typeof route === "string" ? true : (route?.ok ?? route !== undefined);
    const result: TransferResult = {
      content,
      contentType,
      finalUrl: url,
      ok,
      status: ok ? 200 : 404,
    };
    return result;
  };
  return { fetch: fetchPage, calls };
}

const LONG = `# Title\n\n${"content ".repeat(30)}`;

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

describe("probe", () => {
  it("returns a substantial markdown variant", async () => {
    const { fetch, calls } = transport({ "https://example.com/doc.md": LONG });
    const hit = await probe("https://example.com/doc", { fetch, kinds: ["md"] });
    expect(hit).toMatchObject({ kind: "md", url: "https://example.com/doc.md", content: LONG });
    expect(calls.map((call) => call.url)).toEqual(["https://example.com/doc.md"]);
  });

  it("tries index.html.md for a directory URL", async () => {
    const { fetch, calls } = transport({
      "https://example.com/docs/index.html.md": LONG,
    });
    await probe("https://example.com/docs/", { fetch, kinds: ["md"] });
    expect(calls[0]?.url).toBe("https://example.com/docs/index.html.md");
  });

  it("rejects a short or HTML candidate", async () => {
    const { fetch } = transport({
      "https://example.com/doc.md": "<!doctype html><html>shell</html>",
    });
    expect(await probe("https://example.com/doc", { fetch, kinds: ["md"] })).toBeUndefined();

    const second = transport({ "https://example.com/other.md": "too short" });
    expect(
      await probe("https://example.com/other", { fetch: second.fetch, kinds: ["md"] }),
    ).toBeUndefined();
  });

  it("tries kinds in the requested order and stops at the first hit", async () => {
    const { fetch, calls } = transport({
      "https://example.com/page/llms.txt": LONG,
      "https://example.com/page.md": LONG,
    });
    const hit = await probe("https://example.com/page", { fetch });
    expect(hit?.kind).toBe("md");
    expect(calls.map((call) => call.url)).toEqual(["https://example.com/page.md"]);
  });

  it("falls through to llms and caps its timeout", async () => {
    const { fetch, calls } = transport({
      "https://example.com/docs/llms.txt": LONG,
    });
    const hit = await probe("https://example.com/docs/page", {
      fetch,
      timeoutSeconds: 30,
      kinds: ["md", "llms"],
    });
    expect(hit?.kind).toBe("llms");
    const llmsCall = calls.find((call) => call.url.endsWith("llms.txt"));
    expect(llmsCall?.timeoutSeconds).toBe(5);
  });

  it("negotiates markdown from the original URL", async () => {
    const { fetch, calls } = transport({ "https://example.com/page": LONG });
    const hit = await probe("https://example.com/page", {
      fetch,
      kinds: ["negotiation"],
    });
    expect(hit).toMatchObject({ kind: "negotiation", url: "https://example.com/page" });
    expect(calls[0]?.accept).toContain("text/markdown");
  });

  it("passes a resolved cookie source to every candidate", async () => {
    const { fetch, calls } = transport({ "https://example.com/doc.md": LONG });
    await probe("https://example.com/doc", {
      fetch,
      kinds: ["md"],
      cookies: async () => "session=abc",
    });
    expect(calls[0]?.cookies).toBe("session=abc");
  });

  it("resolves the cookie source for each candidate URL", async () => {
    const asked: string[] = [];
    const { fetch, calls } = transport({
      "https://example.com/llms.txt": "",
      "https://example.com/page.md": LONG,
    });
    await probe("https://example.com/page", {
      fetch,
      kinds: ["llms", "md"],
      cookies: (url) => {
        asked.push(url);
        return "session=abc";
      },
    });
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(asked[0]).toContain("llms.txt");
    expect(asked.at(-1)).toContain("page.md");
    expect(calls.every((call) => call.cookies === "session=abc")).toBe(true);
  });

  it("does not probe the same representation twice", async () => {
    const seen = new Set<string>();
    const first = transport({});
    await probe("https://example.com/doc", { fetch: first.fetch, kinds: ["md"], seen });
    const second = transport({ "https://example.com/doc.md": LONG });
    const hit = await probe("https://example.com/doc", {
      fetch: second.fetch,
      kinds: ["md"],
      seen,
    });
    expect(hit).toBeUndefined();
    expect(second.calls).toEqual([]);
  });

  it("stops when the signal is already aborted", async () => {
    const { fetch, calls } = transport({ "https://example.com/doc.md": LONG });
    const controller = new AbortController();
    controller.abort();
    const hit = await probe("https://example.com/doc", {
      fetch,
      kinds: ["md"],
      signal: controller.signal,
    });
    expect(hit).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("accepts a lower minimum length", async () => {
    const { fetch } = transport({ "https://example.com/doc.md": "short body" });
    const hit = await probe("https://example.com/doc", {
      fetch,
      kinds: ["md"],
      minChars: 5,
    });
    expect(hit?.content).toBe("short body");
  });
});

describe("probe options", () => {
  it("defaults to markdown, llms, then negotiation", async () => {
    const calls: string[] = [];
    const fetchPage: ProbeFetch = async (url) => {
      calls.push(url);
      return { content: "", contentType: "text/html", finalUrl: url, ok: true, status: 200 };
    };
    const options: ProbeOptions = { fetch: fetchPage };
    await probe("https://example.com/page", options);
    expect(calls[0]).toBe("https://example.com/page.md");
    expect(calls.some((url) => url.endsWith("llms.txt"))).toBe(true);
    expect(calls.at(-1)).toBe("https://example.com/page");
  });
});
