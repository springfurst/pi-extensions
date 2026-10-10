// SPDX-License-Identifier: MIT
// Opt-in live-network checks for the site handlers and the generic pipeline.
// Run with `npm run test:live`; excluded from the default `npm run test`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeWebFetch, type WebFetchParams, type WebFetchToolResult } from "./tool";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "webtools-live-fetch-"));
  writeFileSync(
    join(dir, "web-tools.json"),
    JSON.stringify({ fetch: { externalReaders: false, remoteFallbacks: false } }),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function fetchUrl(url: string, maxChars = 4000): Promise<WebFetchToolResult> {
  const params: WebFetchParams = { url, max_chars: maxChars };
  return executeWebFetch(params, { cwd: dir, agentDir: dir, trusted: false });
}

function text(result: WebFetchToolResult): string {
  return result.content[0].text;
}

describe("web_fetch live site handlers", () => {
  it("GitHub repository", async () => {
    const result = await fetchUrl("https://github.com/microsoft/TypeScript");
    expect(result.details.method).toBe("github-repo");
    expect(text(result)).toContain("microsoft/TypeScript");
  });

  it("GitHub blob", async () => {
    const result = await fetchUrl("https://github.com/microsoft/TypeScript/blob/main/README.md");
    expect(result.details.method).toBe("github-raw");
    expect(text(result)).toContain("TypeScript");
  });

  it("GitHub issue", async () => {
    const result = await fetchUrl("https://github.com/microsoft/TypeScript/issues/1");
    expect(result.details.method).toBe("github-issue");
    expect(text(result)).toContain("Suggestion");
  });

  it("GitLab repository", async () => {
    const result = await fetchUrl("https://gitlab.com/gitlab-org/gitlab");
    expect(result.details.method).toBe("gitlab-repo");
    expect(text(result)).not.toContain("NaN");
    expect(text(result)).toContain("## README");
  });

  it("GitLab blob", async () => {
    const result = await fetchUrl("https://gitlab.com/gitlab-org/gitlab/-/blob/master/README.md");
    expect(result.details.method).toBe("gitlab-raw");
    expect(text(result)).toContain("GitLab");
  });

  it("npm package", async () => {
    const result = await fetchUrl("https://www.npmjs.com/package/react");
    expect(result.details.method).toBe("npm");
    expect(text(result)).toContain("react");
  });

  it("scoped npm package", async () => {
    const result = await fetchUrl("https://www.npmjs.com/package/@types/node");
    expect(result.details.method).toBe("npm");
    expect(text(result)).toContain("@types/node");
  });

  it("PyPI project", async () => {
    const result = await fetchUrl("https://pypi.org/project/requests/");
    expect(result.details.method).toBe("pypi");
    expect(text(result)).toContain("requests");
  });

  it("crates.io crate", async () => {
    const result = await fetchUrl("https://crates.io/crates/serde");
    expect(result.details.method).toBe("crates.io");
    expect(text(result)).toContain("serde");
  });

  it("docs.rs item", async () => {
    const result = await fetchUrl("https://docs.rs/serde/latest/serde/trait.Serialize.html");
    expect(result.details.method).toBe("docs.rs");
    expect(text(result)).toContain("Serialize");
  });

  it("Wikipedia article does not duplicate its lead", async () => {
    const result = await fetchUrl("https://en.wikipedia.org/wiki/Rust_(programming_language)");
    expect(result.details.method).toBe("wikipedia");
    expect(text(result)).toContain("# Rust (programming language)");
    expect(text(result).match(/Rust is a general-purpose programming language/g)?.length).toBe(1);
  });

  it("arXiv paper", async () => {
    const result = await fetchUrl("https://arxiv.org/abs/1706.03762");
    expect(result.details.method).toBe("arxiv");
    expect(text(result)).toContain("Attention Is All You Need");
  });

  it("PubMed article", async () => {
    const result = await fetchUrl("https://pubmed.ncbi.nlm.nih.gov/31452104/");
    expect(result.details.method).toBe("pubmed");
    expect(text(result)).toContain("PMID");
  });

  it("RFC document", async () => {
    const result = await fetchUrl("https://www.rfc-editor.org/rfc/rfc9110.html");
    expect(result.details.method).toBe("rfc");
    expect(text(result)).toContain("R. Fielding");
    expect(text(result)).toContain("**Status:**");
  });

  it("Hacker News listing", async () => {
    const result = await fetchUrl("https://news.ycombinator.com/");
    expect(result.details.method).toBe("hackernews");
    expect(text(result)).toContain("Hacker News - Top Stories");
  });

  it("Stack Exchange question", async () => {
    const result = await fetchUrl(
      "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array",
    );
    expect(result.details.method).toBe("stackexchange");
    expect(text(result)).toContain("branch prediction");
  });

  it("MDN page with an absolute URL and no duplicated lead", async () => {
    const result = await fetchUrl(
      "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map",
    );
    expect(result.details.method).toBe("mdn");
    expect(result.details.finalUrl).toMatch(/^https:\/\/developer\.mozilla\.org\//);
    expect(text(result).match(/The map\(\) method of Array instances/g)?.length).toBe(1);
  });

  it("Semantic Scholar paper or graceful fallback", async () => {
    const result = await fetchUrl(
      "https://www.semanticscholar.org/paper/Attention-is-All-you-Need-Vaswani-Shazeer/204e3073870fae3d05bcbc2f6a8e263d9b72e776",
    );
    expect(["semantic-scholar", "raw-html"]).toContain(result.details.method);
    expect(text(result).length).toBeGreaterThan(0);
  });

  it("Reddit thread or graceful fallback", async () => {
    const result = await fetchUrl("https://www.reddit.com/r/rust/");
    expect(["reddit", "raw-html"]).toContain(result.details.method);
    expect(text(result).length).toBeGreaterThan(0);
  });
});

describe("web_fetch live generic pipeline", () => {
  it("pretty-prints JSON", async () => {
    const result = await fetchUrl("https://api.github.com/repos/microsoft/TypeScript");
    expect(result.details.method).toBe("json");
    expect(text(result)).toContain('"full_name": "microsoft/TypeScript"');
  });

  it("converts an RSS feed", async () => {
    const result = await fetchUrl("https://news.ycombinator.com/rss");
    expect(result.details.method).toBe("feed");
    expect(text(result)).toContain("# Hacker News");
  });

  it("uses a markdown alternate", async () => {
    const result = await fetchUrl("https://mintlify.com/docs/quickstart");
    expect(result.details.method).toBe("alternate-markdown");
    expect(text(result)).toContain("# Quickstart");
  });

  it("returns plain text", async () => {
    const result = await fetchUrl("https://raw.githubusercontent.com/nodejs/node/main/README.md");
    expect(result.details.method).toBe("text");
    expect(text(result)).toContain("# Node.js");
  });
});
