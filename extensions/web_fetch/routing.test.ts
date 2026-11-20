import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../lib/config";
import { DEFAULT_POLITENESS_CONFIG } from "../../lib/web/config";
import { startServer } from "../../lib/web/__fixtures__/server";
import { createFetchContext } from "./context";
import { renderUrl } from "./pipeline";

const FETCH = {
  ...DEFAULT_CONFIG.fetch,
  allowPrivateHosts: true,
  externalReaders: false,
  remoteFallbacks: false,
};

const POLITENESS = { ...DEFAULT_POLITENESS_CONFIG, robots: "warn" as const };

const SHELL =
  "<!doctype html><html><head><title>App</title></head><body><div id=root></div><noscript>Please enable JavaScript to continue.</noscript></body></html>";

async function renderPolicy(
  handler: Parameters<typeof startServer>[0],
  path: string,
  options: {
    raw?: boolean;
    renderPage?: (url: string) => Promise<{ html: string; status: number; finalUrl: string }>;
  } = {},
) {
  const server = await startServer(handler);
  try {
    const ctx = createFetchContext({
      config: FETCH,
      politeness: POLITENESS,
      hosts: {},
      sessionId: "test-session",
      renderPage: options.renderPage,
    });
    return await renderUrl(`${server.origin}${path}`, {
      raw: options.raw ?? false,
      maxChars: DEFAULT_CONFIG.fetch.maxChars,
      ctx,
    });
  } finally {
    await server.close();
  }
}

describe("routing outcomes in the pipeline", () => {
  it("reports a challenge instead of shaping the interstitial", async () => {
    const result = await renderPolicy((request, response) => {
      if (request.url === "/robots.txt") {
        response.end("User-agent: *\n");
        return;
      }
      response.writeHead(403, { "Content-Type": "text/html" });
      response.end(
        "<html><title>Just a moment...</title><div id='challenge-platform'></div></html>",
      );
    }, "/challenge");

    expect(result.method).toBe("failed");
    expect(result.content).toBe("");
    expect(result.notes.join("\n")).toMatch(/Challenge detected/);
    expect(result.notes.join("\n")).toMatch(/challenge detected/);
    expect(result.notes.join("\n")).toMatch(/:raw/);
  });

  it("reports a consent wall without accepting it", async () => {
    const result = await renderPolicy((request, response) => {
      if (request.url === "/robots.txt") {
        response.end("User-agent: *\n");
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<html><body>We value your privacy. Before you continue, review your cookie consent.</body></html>",
      );
    }, "/consent");

    expect(result.method).toBe("consent");
    expect(result.content).toBe("");
    expect(result.notes.join("\n")).toMatch(/Consent wall/);
    expect(result.notes.join("\n")).toMatch(/:raw/);
  });

  it("escalates a JavaScript shell to the browser tier", async () => {
    const rendered =
      "<html><body><article><h1>Rendered</h1><p>" +
      "word ".repeat(80) +
      "</p></article></body></html>";
    const calls: string[] = [];
    const result = await renderPolicy(
      (request, response) => {
        if (request.url === "/robots.txt") {
          response.end("User-agent: *\n");
          return;
        }
        response.setHeader("Content-Type", "text/html");
        response.end(SHELL);
      },
      "/app",
      {
        renderPage: async (url) => {
          calls.push(url);
          return { html: rendered, status: 200, finalUrl: url };
        },
      },
    );

    expect(calls.length).toBe(1);
    expect(result.content).toContain("Rendered");
    expect(result.notes.join("\n")).toMatch(/needs JavaScript/);
  });

  it("keeps the shell when the browser tier fails", async () => {
    const result = await renderPolicy(
      (request, response) => {
        if (request.url === "/robots.txt") {
          response.end("User-agent: *\n");
          return;
        }
        response.setHeader("Content-Type", "text/html");
        response.end(SHELL);
      },
      "/app",
      {
        renderPage: async () => {
          throw new Error("no browser here");
        },
      },
    );
    expect(result.notes.join("\n")).toMatch(/browser escalation failed/);
  });
});
