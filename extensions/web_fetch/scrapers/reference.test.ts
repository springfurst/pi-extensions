import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtureContext, jsonResponse, textResponse } from "../__fixtures__/context";
import { handleArxiv } from "./arxiv";
import { handleDocsRs, parseDocsRsUrl } from "./docs-rs";
import { handleMDN } from "./mdn";
import { handlePubMed } from "./pubmed";
import { cleanRfcText, extractRfcNumber, handleRfc } from "./rfc";
import { extractPaperId, handleSemanticScholar } from "./semantic-scholar";
import { handleWikipedia } from "./wikipedia";

beforeEach(() => {
  delete process.env.NCBI_API_KEY;
});

describe("handleWikipedia", () => {
  it("renders the summary and sections", async () => {
    const ctx = fixtureContext((url) => {
      if (url.includes("/page/summary/")) {
        return jsonResponse({
          title: "Widget",
          description: "A thing",
          extract: "Widgets are things.",
        });
      }
      if (url.includes("/page/mobile-html/")) {
        return textResponse(
          "<html><body><section><h2>History</h2><p>This is a long enough paragraph about the history of widgets.</p></section></body></html>",
          "text/html",
        );
      }
      return undefined;
    });
    const result = await handleWikipedia("https://en.wikipedia.org/wiki/Widget", ctx);
    expect(result?.method).toBe("wikipedia");
    expect(result?.content).toContain("# Widget");
    expect(result?.content).toContain("## History");
  });

  it("does not duplicate the lead paragraph", async () => {
    const ctx = fixtureContext((url) => {
      if (url.includes("/page/summary/")) {
        return jsonResponse({
          title: "Widget",
          description: "A thing",
          extract: "Widgets are things.",
        });
      }
      if (url.includes("/page/mobile-html/")) {
        return textResponse(
          "<html><body><section><p>Widgets are things and they are used in many places around the world.</p></section><section><h2>History</h2><p>This is a long enough paragraph about the history of widgets.</p></section></body></html>",
          "text/html",
        );
      }
      return undefined;
    });
    const result = await handleWikipedia("https://en.wikipedia.org/wiki/Widget", ctx);
    expect(result?.content.match(/Widgets are things/g)?.length).toBe(1);
    expect(result?.content).toContain("## History");
  });
});

describe("handleArxiv", () => {
  it("renders metadata and abstract", async () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title> A Paper </title>
      <summary>Abstract text.</summary>
      <author><name>Ada</name></author>
      <published>2024-01-01T00:00:00Z</published>
      <category term="cs.CL"/>
    </entry></feed>`;
    const ctx = fixtureContext((url) =>
      url.includes("export.arxiv.org") ? textResponse(atom, "application/atom+xml") : undefined,
    );
    const result = await handleArxiv("https://arxiv.org/abs/2401.00001", ctx);
    expect(result?.method).toBe("arxiv");
    expect(result?.content).toContain("Ada");
    expect(result?.content).toContain("Abstract text.");
  });
});

describe("semantic scholar helpers", () => {
  it("extracts a paper id", () => {
    const id = "a".repeat(40);
    expect(extractPaperId(`https://www.semanticscholar.org/paper/Title/${id}`)).toBe(id);
    expect(extractPaperId("https://example.com")).toBeNull();
  });

  it("renders a paper", async () => {
    const id = "b".repeat(40);
    const ctx = fixtureContext((url) =>
      url.includes("api.semanticscholar.org")
        ? jsonResponse({
            paperId: id,
            title: "Paper",
            year: 2024,
            abstract: "Abstract",
            citationCount: 1500,
          })
        : undefined,
    );
    const result = await handleSemanticScholar(
      `https://www.semanticscholar.org/paper/Title/${id}`,
      ctx,
    );
    expect(result?.method).toBe("semantic-scholar");
    expect(result?.content).toContain("# Paper");
    expect(result?.content).toContain("1.5K");
  });
});

describe("rfc helpers", () => {
  it("extracts the RFC number from known hosts", () => {
    expect(extractRfcNumber(new URL("https://www.rfc-editor.org/rfc/rfc9110.html"))).toBe("9110");
    expect(extractRfcNumber(new URL("https://datatracker.ietf.org/doc/html/rfc9110"))).toBe("9110");
    expect(extractRfcNumber(new URL("https://example.com/rfc9110"))).toBeNull();
  });

  it("strips pagination noise", () => {
    expect(cleanRfcText("keep\n\fdrop\ndrop\ndrop\ndrop\n[Page 1]\nkeep too")).toBe(
      "keep\nkeep too",
    );
  });

  it("renders metadata and full text", async () => {
    const ctx = fixtureContext((url) => {
      if (url.endsWith(".json"))
        return jsonResponse({
          title: "HTTP Semantics",
          authors: ["R. Fielding, Ed.", "M. Nottingham, Ed."],
          status: "INTERNET STANDARD",
          source: "HTTP",
          abstract: "The abstract.",
        });
      if (url.endsWith(".txt")) return textResponse("RFC body text");
      return undefined;
    });
    const result = await handleRfc("https://www.rfc-editor.org/rfc/rfc9110", ctx);
    expect(result?.method).toBe("rfc");
    expect(result?.content).toContain("RFC 9110");
    expect(result?.content).toContain("R. Fielding, Ed., M. Nottingham, Ed.");
    expect(result?.content).toContain("**Status:** INTERNET STANDARD");
    expect(result?.content).toContain("**Stream:** HTTP");
    expect(result?.content).toContain("RFC body text");
  });
});

describe("handleMDN", () => {
  it("renders prose and code sections", async () => {
    const ctx = fixtureContext((url) =>
      url.endsWith("/index.json")
        ? jsonResponse({
            doc: {
              title: "Array",
              summary: "<p>The Array object.</p>",
              mdn_url:
                "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array",
              body: [
                { type: "prose", value: { title: "Description", content: "<p>Details here.</p>" } },
                {
                  type: "code_example",
                  value: { title: "Example", code: "const a = [];", language: "js" },
                },
              ],
            },
          })
        : undefined,
    );
    const result = await handleMDN(
      "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array",
      ctx,
    );
    expect(result?.method).toBe("mdn");
    expect(result?.content).toContain("# Array");
    expect(result?.content).toContain("## Description");
    expect(result?.content).toContain("```js");
  });

  it("resolves a relative final URL and drops the duplicate lead prose", async () => {
    const ctx = fixtureContext((url) =>
      url.endsWith("/index.json")
        ? jsonResponse({
            doc: {
              title: "Widget",
              summary: "<p>Lead text.</p>",
              mdn_url: "/en-US/docs/Web/Widget",
              body: [
                { type: "prose", value: { content: "<p>Lead text.</p>" } },
                { type: "prose", value: { title: "Usage", content: "<p>Usage.</p>" } },
              ],
            },
          })
        : undefined,
    );
    const result = await handleMDN("https://developer.mozilla.org/en-US/docs/Web/Widget", ctx);
    expect(result?.finalUrl).toBe("https://developer.mozilla.org/en-US/docs/Web/Widget");
    expect(result?.content.match(/Lead text\./g)?.length).toBe(1);
    expect(result?.content).toContain("## Usage");
  });
});

describe("handlePubMed", () => {
  it("renders metadata, abstract, and MeSH terms", async () => {
    const ctx = fixtureContext((url) => {
      if (url.includes("esummary.fcgi")) {
        return jsonResponse({
          result: {
            "12345": {
              title: "A Study",
              authors: [{ name: "Smith J" }],
              fulljournalname: "Journal",
              pubdate: "2024",
              volume: "1",
              pages: "10-20",
              articleids: [{ idtype: "doi", value: "10.1/x" }],
            },
          },
        });
      }
      if (url.includes("rettype=abstract")) return textResponse("The abstract.");
      if (url.includes("rettype=medline")) return textResponse("MH  - Humans\nMH  - Disease\n");
      return undefined;
    });
    const result = await handlePubMed("https://pubmed.ncbi.nlm.nih.gov/12345/", ctx);
    expect(result?.method).toBe("pubmed");
    expect(result?.content).toContain("A Study");
    expect(result?.content).toContain("The abstract.");
    expect(result?.content).toContain("- Humans");
  });
});

describe("handleDocsRs", () => {
  it("parses rustdoc URLs", () => {
    expect(parseDocsRsUrl("https://docs.rs/mycrate/1.0.0/mycrate/struct.MyStruct.html")).toEqual({
      crateName: "mycrate",
      version: "1.0.0",
      modulePath: ["mycrate"],
      itemKind: "struct",
      itemName: "MyStruct",
    });
    expect(parseDocsRsUrl("https://example.com/x")).toBeNull();
  });

  it("renders an item from rustdoc JSON", async () => {
    const crate = {
      root: 0,
      crate_version: "1.0.0",
      format_version: 1,
      paths: {},
      index: {
        "0": {
          name: "mycrate",
          docs: "Crate docs",
          attrs: [],
          inner: { module: { items: [1] } },
          visibility: "public",
          deprecation: null,
        },
        "1": {
          name: "MyStruct",
          docs: "A struct.",
          attrs: [],
          inner: { struct: { generics: { params: [] }, kind: {}, impls: [] } },
          visibility: "public",
          deprecation: null,
        },
      },
    };
    const gz = gzipSync(JSON.stringify(crate));
    const ctx = fixtureContext((url) =>
      url.endsWith("/json.gz")
        ? new Response(gz, { status: 200, headers: { "Content-Type": "application/gzip" } })
        : undefined,
    );
    const result = await handleDocsRs(
      "https://docs.rs/mycrate/1.0.0/mycrate/struct.MyStruct.html",
      ctx,
    );
    expect(result?.method).toBe("docs.rs");
    expect(result?.content).toContain("# struct MyStruct");
    expect(result?.content).toContain("A struct.");
  });
});
