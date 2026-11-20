import { describe, expect, it } from "vitest";
import {
  classifyResponse,
  detectChallenge,
  formatDelay,
  looksLikeConsentWall,
  looksLikeJsShell,
  parseRetryAfter,
  planRetry,
  retryAfterFromHeaders,
} from "./outcome";

const NOW = Date.parse("2026-11-20T12:00:00Z");

const html = (body: string): { status: number; body: string; contentType: string } => ({
  status: 200,
  body,
  contentType: "text/html; charset=utf-8",
});

describe("classifyResponse", () => {
  it("accepts usable content", () => {
    expect(classifyResponse(html("<html><body>Hello</body></html>"))).toEqual({ outcome: "ok" });
  });

  it("flags a JavaScript shell", () => {
    const result = classifyResponse(html("<html><body>Please enable JavaScript</body></html>"));
    expect(result.outcome).toBe("js-shell");
  });

  it("does not call plain text a JavaScript shell", () => {
    const result = classifyResponse({
      status: 200,
      body: "enable javascript is a phrase in this article",
      contentType: "text/plain",
    });
    expect(result.outcome).toBe("ok");
  });

  it("detects a consent wall", () => {
    const result = classifyResponse(
      html(
        "<html><body>We value your privacy. Before you continue, review your options.</body></html>",
      ),
    );
    expect(result.outcome).toBe("consent");
  });

  it("requires two consent markers", () => {
    expect(looksLikeConsentWall(html("We value your privacy."))).toBe(false);
  });

  it("ignores consent markers in long articles", () => {
    const article = `${"we value your privacy ".repeat(1_000)}before you continue`;
    expect(looksLikeConsentWall(html(article))).toBe(false);
  });

  it("detects a challenge on a 200 shell before shaping", () => {
    const result = classifyResponse({
      status: 200,
      contentType: "text/html",
      body: "<html><title>Just a moment...</title><script src='https://challenge-platform.cloudflare.com/x'></script></html>",
    });
    expect(result.outcome).toBe("challenge");
    expect(result.challenge?.type).toBe("cloudflare");
    expect(result.challenge?.severity).toBe("blocking");
  });

  it("detects a challenge from a response header alone", () => {
    const result = classifyResponse({
      status: 403,
      headers: { "cf-mitigated": "challenge" },
      body: "blocked",
    });
    expect(result.outcome).toBe("challenge");
    expect(result.challenge?.type).toBe("cloudflare");
    expect(result.challenge?.evidence).toEqual(["cf-mitigated"]);
  });

  it("reports an embedded captcha as present, not blocking", () => {
    const result = classifyResponse(
      html("<html><div class='g-recaptcha' data-sitekey='x'></div></html>"),
    );
    expect(result.outcome).toBe("challenge");
    expect(result.challenge).toMatchObject({ type: "recaptcha", severity: "present" });
  });

  it("names the challenge families it knows", () => {
    const cases: Array<[string, string]> = [
      ["Making sure you're not a bot — Anubis", "anubis"],
      ["<div id='px-captcha'></div>", "perimeterx"],
      ["<script src='https://js.datadome.co/tags.js'></script>", "datadome"],
      ["<div class='h-captcha'></div>", "hcaptcha"],
    ];
    for (const [body, family] of cases) {
      expect(detectChallenge(html(body))?.type).toBe(family);
    }
  });

  it("treats a 403 without markers as a hard block", () => {
    expect(classifyResponse({ status: 403, body: "forbidden" })).toEqual({
      outcome: "blocked-hard",
      reason: "HTTP 403 without challenge markers",
    });
  });

  it("keeps other failures apart", () => {
    expect(classifyResponse({ status: 404 }).outcome).toBe("http-error");
    expect(classifyResponse({ status: 500 }).outcome).toBe("http-error");
  });

  it("classifies rate limits even when a challenge marker is absent", () => {
    const result = classifyResponse({ status: 429, headers: { "retry-after": "120" } });
    expect(result).toMatchObject({ outcome: "throttled", retryAfterMs: 120_000 });
    expect(classifyResponse({ status: 503 }).outcome).toBe("throttled");
  });

  it("prefers a challenge over a throttle when both signals appear", () => {
    const result = classifyResponse({
      status: 503,
      headers: { "retry-after": "30" },
      body: "<title>Just a moment...</title>",
    });
    expect(result.outcome).toBe("challenge");
  });

  it("leaves whether to retry to the caller", () => {
    expect(looksLikeJsShell(html("Enable JavaScript to continue"))).toBe(true);
  });
});

describe("parseRetryAfter", () => {
  it("parses delay-seconds", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120_000);
    expect(parseRetryAfter("0", NOW)).toBe(0);
  });

  it("parses an HTTP-date", () => {
    expect(parseRetryAfter("Thu, 20 Nov 2026 12:00:30 GMT", NOW)).toBe(30_000);
  });

  it("clamps a past date to zero", () => {
    expect(parseRetryAfter("Thu, 20 Nov 2026 11:00:00 GMT", NOW)).toBe(0);
  });

  it("returns undefined for missing or unparseable values", () => {
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfter("", NOW)).toBeUndefined();
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
  });

  it("does not clamp long delays", () => {
    expect(parseRetryAfter("3600", NOW)).toBe(3_600_000);
  });

  it("falls back to rate-limit reset headers", () => {
    expect(retryAfterFromHeaders({ "rate-limit-reset": "45" }, NOW)).toBe(45_000);
    expect(retryAfterFromHeaders({ "x-ratelimit-reset": String(NOW / 1000 + 90) }, NOW)).toBe(
      90_000,
    );
    expect(retryAfterFromHeaders({ "x-ratelimit-reset": "12345" }, NOW)).toBeUndefined();
  });
});

describe("planRetry", () => {
  it("waits when the delay fits the budget", () => {
    expect(planRetry(5_000, 30_000, NOW)).toEqual({
      action: "wait",
      delayMs: 5_000,
      reason: "host asked to wait 5 seconds",
    });
  });

  it("fails fast with the retry time when the delay is too long", () => {
    const plan = planRetry(600_000, 30_000, NOW);
    expect(plan.action).toBe("fail");
    expect(plan.reason).toContain("10 minutes");
    expect(plan.reason).toContain("2026-11-20T12:10:00.000Z");
  });

  it("backs off a second when no delay was given", () => {
    expect(planRetry(undefined, 30_000, NOW)).toMatchObject({ action: "wait", delayMs: 1_000 });
  });
});

describe("formatDelay", () => {
  it("uses the largest unit that fits", () => {
    expect(formatDelay(250)).toBe("250 ms");
    expect(formatDelay(1_000)).toBe("1 second");
    expect(formatDelay(45_000)).toBe("45 seconds");
    expect(formatDelay(120_000)).toBe("2 minutes");
    expect(formatDelay(7_200_000)).toBe("2 hours");
  });
});
