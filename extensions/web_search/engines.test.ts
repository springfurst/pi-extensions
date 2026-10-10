import { describe, expect, it } from "vitest";
import type { BrowserRenderer } from "../../lib/browser";
import { engineParams, htmlFetch } from "./__fixtures__/search";
import {
  createDuckDuckGoForm,
  decodeHtmlText,
  isAnomalyResponse,
  localeToKl,
  parseContinuationForm,
  parseHtmlResults as parseDdgResults,
  searchDuckDuckGo,
  unwrapResultUrl,
} from "./engines/duckduckgo";
import {
  isChallengeResponse,
  parseHtmlResults as parseStartpageResults,
  parseSearchFormInputs,
  searchStartpage,
} from "./engines/startpage";
import { findSearxngAuth, searchSearXNG, stripExternalBangs } from "./engines/searxng";
import {
  blockReason as googleBlockReason,
  buildSearchUrl as buildGoogleSearchUrl,
  parseHtmlResults as parseGoogleResults,
  searchGoogle,
  unwrapResultUrl as unwrapGoogleUrl,
} from "./engines/google";

const DDG_HTML = `
<div class="result results_links web-result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=abc">Example &amp; One</a>
  <a class="result__snippet" href="https://example.com/one">Snippet one</a>
</div>
<div class="result results_links web-result">
  <a class="result__a" href="https://example.com/two">Two</a>
  <div class="result__snippet">Snippet two</div>
</div>
`;

describe("duckduckgo", () => {
  it("unwraps redirect links", () => {
    expect(
      unwrapResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&rut=abc"),
    ).toBe("https://example.com/one");
    expect(unwrapResultUrl("https://example.com/direct")).toBe("https://example.com/direct");
  });

  it("decodes entities and parses results", () => {
    expect(decodeHtmlText("<b>Hello</b> &amp; goodbye")).toBe("Hello & goodbye");
    const results = parseDdgResults(DDG_HTML);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: "Example & One", url: "https://example.com/one" });
    expect(results[1]?.snippet).toBe("Snippet two");
  });

  it("maps locales to DDG kl codes", () => {
    expect(localeToKl("en-us")).toBe("us-en");
    expect(localeToKl("en-gb")).toBe("uk-en");
    expect(localeToKl("de")).toBeUndefined();
  });

  it("detects anomaly pages and continuation forms", () => {
    expect(isAnomalyResponse('<div class="anomaly-modal"></div>')).toBe(true);
    expect(
      parseContinuationForm(
        '<form><input name="s" value="10"><input name="vqd" value="x"></form>',
      )?.get("s"),
    ).toBe("10");
  });

  it("builds a form with query syntax and recency", () => {
    const form = createDuckDuckGoForm(
      engineParams({ query: 'site:example.com "a b"', recency: "week" }),
    );
    expect(form.get("q")).toBe('"a b" site:example.com');
    expect(form.get("df")).toBe("w");
  });

  it("searches via the HTML endpoint", async () => {
    const fetchImpl = htmlFetch([["duckduckgo.com", DDG_HTML]]);
    const response = await searchDuckDuckGo(engineParams({ query: "example", fetch: fetchImpl }));
    expect(response.provider).toBe("duckduckgo");
    expect(response.sources).toHaveLength(2);
  });
});

const STARTPAGE_HTML = `
<div class="result">
  <a class="result-link" href="https://example.com/a"><h2>Result A</h2></a>
  <p class="description">Description A</p>
</div>
`;

describe("startpage", () => {
  it("extracts the search form's hidden inputs", () => {
    const inputs = parseSearchFormInputs(
      '<form action="/sp/search"><input type="hidden" name="sc" value="token"><input type="hidden" name="query" value=""></form>',
    );
    expect(inputs).toEqual({ sc: "token", query: "" });
    expect(parseSearchFormInputs("<html></html>")).toBeUndefined();
  });

  it("parses results and detects challenge pages", () => {
    const results = parseStartpageResults(STARTPAGE_HTML);
    expect(results).toEqual([
      { title: "Result A", url: "https://example.com/a", snippet: "Description A" },
    ]);
    expect(
      isChallengeResponse({ url: "https://www.startpage.com/en/errors/", status: 200, html: "" }),
    ).toBe(true);
    expect(
      isChallengeResponse({
        url: "https://www.startpage.com/sp/search",
        status: 200,
        html: STARTPAGE_HTML,
      }),
    ).toBe(false);
    expect(
      isChallengeResponse({
        url: "https://www.startpage.com/sp/search",
        status: 200,
        html: '<script id="anubis-main" src="/.within.website/x/cmd/anubis/static/js/main.mjs"></script>',
      }),
    ).toBe(true);
  });

  it("searches via homepage-token flow and direct GET", async () => {
    const fetchImpl = htmlFetch([
      ["startpage.com/sp/search", STARTPAGE_HTML],
      ["startpage.com", "<html></html>"],
    ]);
    const response = await searchStartpage(engineParams({ query: "example", fetch: fetchImpl }));
    expect(response.provider).toBe("startpage");
    expect(response.sources).toHaveLength(1);
  });
});

describe("searxng", () => {
  it("resolves auth and strips external bangs", () => {
    expect(findSearxngAuth({ token: "t" })).toEqual({ type: "bearer", value: "t" });
    expect(findSearxngAuth({ basicUsername: "u", basicPassword: "p" })?.type).toBe("basic");
    expect(() => findSearxngAuth({ basicUsername: "u" })).toThrow();
    expect(stripExternalBangs("!!g keep foo")).toBe("keep foo");
  });

  it("throws when no endpoint is configured", async () => {
    await expect(searchSearXNG(engineParams({ query: "x" }))).rejects.toThrow(
      /endpoint not configured/i,
    );
  });

  it("maps the JSON API response", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "A",
              url: "https://a.example",
              content: "snippet",
              publishedDate: "2024-01-01T00:00:00Z",
            },
          ],
          answers: ["42"],
          suggestions: ["more"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const response = await searchSearXNG(
      engineParams({
        query: "answer",
        fetch: fetchImpl,
        searxng: { endpoint: "https://searx.example" },
      }),
    );
    expect(response.provider).toBe("searxng");
    expect(response.sources[0]).toMatchObject({
      title: "A",
      url: "https://a.example",
      snippet: "snippet",
    });
    expect(response.answer).toBe("42");
    expect(response.relatedQuestions).toEqual(["more"]);
  });
});

const GOOGLE_HTML = `
<div class="Gx5Zad fP1Qef">
  <a href="/url?q=https%3A%2F%2Fexample.com%2Fone&sa=U"><h3>Example One</h3></a>
  <div class="VwiC3b">Snippet one</div>
</div>
<div class="Gx5Zad fP1Qef">
  <a href="https://example.com/two"><h3>Example Two</h3></a>
  <div class="IsZvec">Snippet two</div>
</div>
`;

describe("google", () => {
  it("unwraps /url redirects and rejects google-internal links", () => {
    expect(unwrapGoogleUrl("/url?q=https%3A%2F%2Fexample.com%2Fone&sa=U")).toBe(
      "https://example.com/one",
    );
    expect(unwrapGoogleUrl("https://example.com/two")).toBe("https://example.com/two");
    expect(unwrapGoogleUrl("https://www.google.com/search?q=x")).toBeUndefined();
    expect(unwrapGoogleUrl("javascript:void(0)")).toBeUndefined();
  });

  it("parses titles, urls, and snippets in document order", () => {
    expect(parseGoogleResults(GOOGLE_HTML)).toEqual([
      { title: "Example One", url: "https://example.com/one", snippet: "Snippet one" },
      { title: "Example Two", url: "https://example.com/two", snippet: "Snippet two" },
    ]);
  });

  it("builds a no-JS web-results URL with recency", () => {
    const url = buildGoogleSearchUrl(engineParams({ query: "rust", recency: "week" }), 5);
    expect(url).toContain("udm=14");
    expect(url).toContain("num=5");
    expect(url).toContain("tbs=qdr%3Aw");
    expect(url).toContain("q=rust");
  });

  it("detects JS shells and traffic challenges", () => {
    expect(
      googleBlockReason({
        html: '<a href="/httpservice/retry/enablejs">',
        status: 200,
        url: "https://www.google.com/search",
      }),
    ).toBe("javascript");
    expect(
      googleBlockReason({
        html: "detected unusual traffic",
        status: 200,
        url: "https://www.google.com/search",
      }),
    ).toBe("traffic");
    expect(
      googleBlockReason({
        html: GOOGLE_HTML,
        status: 200,
        url: "https://www.google.com/search",
      }),
    ).toBeUndefined();
  });

  it("searches through an injected browser renderer", async () => {
    const renderPage: BrowserRenderer = async (url) => ({
      html: GOOGLE_HTML,
      status: 200,
      finalUrl: url,
    });
    const response = await searchGoogle(engineParams({ query: "example", renderPage }));
    expect(response.provider).toBe("google");
    expect(response.sources).toHaveLength(2);
    expect(response.sources[0]).toMatchObject({
      title: "Example One",
      url: "https://example.com/one",
      snippet: "Snippet one",
    });
  });

  it("throws a provider error when no browser is available", async () => {
    await expect(searchGoogle(engineParams({ query: "example" }))).rejects.toThrow(
      /no browser resolved/i,
    );
  });
});
