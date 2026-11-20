import { describe, expect, it } from "vitest";
import { FakeClock } from "./__fixtures__/clock";
import type { PolitenessConfig } from "./config";
import { sharedPoliteness } from "./politeness";
import { WebRuntime, type BrowserTransport } from "./runtime";
import type { TransferResult } from "./transfer";
import type { WebRequest, WebResult } from "./types";

const politeness: PolitenessConfig = {
  robots: "warn",
  tier: "polite",
  evasion: "off",
  human: "hint",
  globalConcurrency: 4,
  globalRequestsPerSecond: 100,
  latencyWarningFactor: 2,
  maxRetryWaitSeconds: 30,
};

interface Harness {
  runtime: WebRuntime;
  clock: FakeClock;
  transfers: string[];
  browserCalls: Array<{ tier: number; url: string }>;
  queue(...results: TransferResult[]): void;
}

function harness(
  options: {
    config?: Partial<PolitenessConfig>;
    browser?: boolean;
    browserResult?: WebResult;
    humanWaiter?: (context: { url: string; signal?: AbortSignal }) => Promise<boolean>;
  } = {},
): Harness {
  const clock = new FakeClock();
  const transfers: string[] = [];
  const browserCalls: Array<{ tier: number; url: string }> = [];
  const queue: TransferResult[] = [];
  const config = { ...politeness, ...options.config };
  const state = sharedPoliteness({ dir: "", politeness: config, clock });
  const browserTransport: BrowserTransport = async (request, call) => {
    browserCalls.push({ tier: call.tier, url: request.url });
    return (
      options.browserResult ?? {
        url: request.url,
        status: 200,
        outcome: "ok",
        tier: call.tier,
        transport: "browser",
        body: "<html>rendered</html>",
        contentType: "text/html",
      }
    );
  };
  const runtime = new WebRuntime({
    politeness: state,
    clock,
    transfer: async (url) => {
      transfers.push(url);
      const next = queue.shift();
      if (!next) throw new Error(`no queued transfer for ${url}`);
      return next;
    },
    browser: options.browser === false ? undefined : browserTransport,
    humanWaiter: options.humanWaiter,
  });
  return {
    runtime,
    clock,
    transfers,
    browserCalls,
    queue: (...results) => queue.push(...results),
  };
}

function request(overrides: Partial<WebRequest> = {}): WebRequest {
  return {
    url: "https://example.com/page",
    purpose: "fetch",
    sessionId: "s1",
    ...overrides,
  };
}

const ok = (): TransferResult => ({
  content: "<html>hello</html>",
  contentType: "text/html",
  finalUrl: "https://example.com/page",
  ok: true,
  status: 200,
  outcome: "ok",
});

const shell = (): TransferResult => ({
  content: "<html><div id=root></div></body></html>",
  contentType: "text/html",
  finalUrl: "https://example.com/page",
  ok: true,
  status: 200,
  outcome: "js-shell",
});

const blocked = (): TransferResult => ({
  content: "",
  contentType: "",
  finalUrl: "https://example.com/page",
  ok: false,
  status: 403,
  outcome: "blocked-hard",
  error: "HTTP 403",
});

const challenged = (): TransferResult => ({
  content: "<html>Just a moment...</html>",
  contentType: "text/html",
  finalUrl: "https://example.com/page",
  ok: false,
  status: 403,
  outcome: "challenge",
  error: "HTTP 403: challenge detected (cloudflare)",
  challenge: { type: "cloudflare", severity: "blocking", evidence: ["just a moment"] },
});

describe("WebRuntime", () => {
  it("returns usable content from the honest tier", async () => {
    const test = harness();
    test.queue(ok());
    const result = await test.runtime.request(request());
    expect(result).toMatchObject({ tier: 0, transport: "http", outcome: "ok", status: 200 });
    expect(result.body).toBe("<html>hello</html>");
    expect(test.transfers).toEqual(["https://example.com/page"]);
    expect(test.browserCalls).toEqual([]);
  });

  it("escalates a JavaScript shell to the browser tier", async () => {
    const test = harness();
    test.queue(shell());
    const result = await test.runtime.request(request());
    expect(result.transport).toBe("browser");
    expect(result.tier).toBe(1);
    expect(result.body).toBe("<html>rendered</html>");
    expect(test.browserCalls).toEqual([{ tier: 1, url: "https://example.com/page" }]);
    expect(result.notes?.join("\n")).toContain("needs JavaScript");
  });

  it("reports a shell when no browser is available", async () => {
    const test = harness({ browser: false });
    test.queue(shell());
    const result = await test.runtime.request(request());
    expect(result.outcome).toBe("js-shell");
    expect(result.tier).toBe(0);
    expect(result.notes?.join("\n")).toContain("no browser transport");
  });

  it("never escalates a challenge and reports it as needing a human", async () => {
    const test = harness();
    test.queue(challenged());
    const result = await test.runtime.request(request());
    expect(result.outcome).toBe("challenge");
    expect(result.tier).toBe(0);
    expect(test.browserCalls).toEqual([]);
    expect(result.notes?.join("\n")).toContain("needs a human");
    expect(result.challenge?.type).toBe("cloudflare");
  });

  it("fails cleanly when human handling is disabled", async () => {
    const test = harness({ config: { human: "disabled" } });
    test.queue(challenged());
    const result = await test.runtime.request(request());
    expect(result.outcome).toBe("challenge");
    expect(result.reason).toContain("human handling is disabled");
  });

  it("waits in transparent mode and retries after a human clears it", async () => {
    let waited = 0;
    const test = harness({
      config: { human: "transparent" },
      humanWaiter: async () => {
        waited++;
        return true;
      },
    });
    test.queue(challenged(), ok());
    const result = await test.runtime.request(request());
    expect(waited).toBe(1);
    expect(result.outcome).toBe("ok");
    expect(result.tier).toBe(0);
    expect(result.notes?.join("\n")).toContain("cleared the challenge");
  });

  it("reports the challenge when the human wait does not clear it", async () => {
    const test = harness({
      config: { human: "transparent" },
      humanWaiter: async () => false,
    });
    test.queue(challenged());
    const result = await test.runtime.request(request());
    expect(result.outcome).toBe("challenge");
    expect(result.notes?.join("\n")).toContain("without clearing");
  });

  it("degrades transparent to a hint when it cannot wait", async () => {
    const test = harness({ config: { human: "transparent" } });
    test.queue(challenged());
    const result = await test.runtime.request(request());
    expect(result.outcome).toBe("challenge");
    expect(result.notes?.join("\n")).toContain("cannot wait");
  });

  it("escalates a hard block only with evasion on and the evasive tier", async () => {
    const test = harness({ config: { tier: "evasive", evasion: "on-block" } });
    test.queue(blocked());
    const result = await test.runtime.request(request());
    expect(result.tier).toBe(2);
    expect(test.browserCalls).toEqual([{ tier: 2, url: "https://example.com/page" }]);
  });

  it("does not escalate a hard block by default", async () => {
    const test = harness();
    test.queue(blocked());
    const result = await test.runtime.request(request());
    expect(result.tier).toBe(0);
    expect(test.browserCalls).toEqual([]);
  });

  it("escalates at most once per host per window", async () => {
    const test = harness({ config: { tier: "evasive", evasion: "on-block" } });
    test.queue(blocked(), blocked());
    await test.runtime.request(request());
    await test.runtime.request(request());
    expect(test.browserCalls.length).toBe(1);
    test.clock.advanceBy(10 * 60_000);
    test.queue(blocked());
    await test.runtime.request(request());
    expect(test.browserCalls.length).toBe(2);
  });

  it("honors a per-call tier ceiling", async () => {
    const test = harness({ config: { tier: "evasive", evasion: "on-block" } });
    test.queue(blocked());
    const result = await test.runtime.request(request({ tier: 1 }));
    expect(result.tier).toBe(0);
    expect(test.browserCalls).toEqual([]);
    expect(result.notes?.join("\n")).toContain("ceiling");
  });

  it("never escalates a robots refusal", async () => {
    const test = harness({ config: { tier: "evasive", evasion: "on-block" } });
    test.queue({
      content: "",
      contentType: "",
      finalUrl: "https://example.com/private",
      ok: false,
      outcome: "robots-disallow",
      error: "robots.txt disallows /private",
    });
    const result = await test.runtime.request(request({ url: "https://example.com/private" }));
    expect(result.outcome).toBe("robots-disallow");
    expect(test.browserCalls).toEqual([]);
  });

  it("carries a throttle's retry delay through", async () => {
    const test = harness();
    test.queue({
      content: "",
      contentType: "",
      finalUrl: "https://example.com/page",
      ok: false,
      status: 429,
      outcome: "throttled",
      retryAfterMs: 60_000,
      error: "HTTP 429: host asked to wait 1 minute",
    });
    const result = await test.runtime.request(request());
    expect(result).toMatchObject({ outcome: "throttled", retryAfterMs: 60_000 });
  });

  it("maps a transfer without an outcome using ok", async () => {
    const test = harness();
    test.queue({
      content: "plain",
      contentType: "text/plain",
      finalUrl: "https://example.com/page",
      ok: true,
      status: 200,
    });
    const result = await test.runtime.request(request());
    expect(result.outcome).toBe("ok");
  });

  it("sends profile cookies when a cookie source is configured", async () => {
    const cookies: Array<string | undefined> = [];
    const clock = new FakeClock();
    const state = sharedPoliteness({ dir: "", politeness, clock });
    const runtime = new WebRuntime({
      politeness: state,
      clock,
      cookieSource: async () => "session=abc",
      transfer: async (_url, options) => {
        cookies.push(options?.cookies);
        return {
          content: "ok",
          contentType: "text/plain",
          finalUrl: "https://example.com/",
          ok: true,
          status: 200,
          outcome: "ok",
        };
      },
    });
    await runtime.request(request({ cookies: "profile" }));
    expect(cookies).toEqual(["session=abc"]);
  });

  it("refuses to open a session without a factory", async () => {
    const test = harness();
    await expect(test.runtime.openSession("s1", { isolation: "tabs" })).rejects.toThrow(
      /no browser session factory/,
    );
  });
});
