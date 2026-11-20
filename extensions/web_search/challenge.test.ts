import { describe, expect, it } from "vitest";
import { classifyProviderHttpError, fetchPage, type LoadedPage } from "./engines/http";
import { SearchProviderError } from "./types";

describe("classifyProviderHttpError", () => {
  it("recognizes a shared challenge body", () => {
    const error = classifyProviderHttpError(
      "ecosia",
      403,
      "<html><title>Just a moment...</title><div id='challenge-platform'></div></html>",
    );
    expect(error).toBeInstanceOf(SearchProviderError);
    expect(error?.isChallenge).toBe(true);
    expect(error?.status).toBe(403);
    expect(error?.message).toContain("Ecosia");
  });

  it("keeps quota and auth errors apart from challenges", () => {
    const credits = classifyProviderHttpError("searxng", 200, "quota exceeded");
    expect(credits?.isChallenge).toBe(false);
    const auth = classifyProviderHttpError("google", 401, "nope");
    expect(auth?.isChallenge).toBe(false);
    expect(auth?.message).toContain("401");
  });

  it("seeds a retry delay from the response", () => {
    const error = classifyProviderHttpError(
      "startpage",
      429,
      "<div class='h-captcha'></div>",
      120_000,
    );
    expect(error?.retryAfterMs).toBe(120_000);
    expect(error?.isChallenge).toBe(true);
  });

  it("treats 429 and 503 as challenge-class failures", () => {
    expect(new SearchProviderError("google", "slow", 429).isChallenge).toBe(true);
    expect(new SearchProviderError("google", "down", 503).isChallenge).toBe(true);
    expect(new SearchProviderError("google", "nope", 404).isChallenge).toBe(false);
  });
});

describe("fetchPage", () => {
  it("reports the retry delay from the response headers", async () => {
    const fetchImpl = (async () =>
      new Response("busy", {
        status: 429,
        headers: { "Retry-After": "30" },
      })) as typeof fetch;
    const page: LoadedPage = await fetchPage("https://example.com/", { fetch: fetchImpl });
    expect(page.status).toBe(429);
    expect(page.retryAfterMs).toBe(30_000);
  });
});
