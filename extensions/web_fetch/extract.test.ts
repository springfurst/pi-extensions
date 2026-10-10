import { describe, expect, it } from "vitest";
import {
  isLowQualityOutput,
  looksLikeHtml,
  readabilityToMarkdown,
  stripDataUriImages,
} from "./extract";

const ARTICLE = `<!doctype html><html><head><title>Test Article</title></head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<article>
<h1>Understanding Widgets</h1>
<p>This is a reasonably long paragraph that should survive readability extraction. It contains enough
words to be considered the main content of the page by the algorithm, hopefully more than the default
character threshold would demand.</p>
<p>Second paragraph with a <a href="https://example.com">link</a> and some <code>code</code>.</p>
<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
</article>
<footer>Copyright 2024</footer>
</body></html>`;

describe("readabilityToMarkdown", () => {
  it("extracts and converts the article body", () => {
    const markdown = readabilityToMarkdown(ARTICLE);
    expect(markdown).not.toBeNull();
    expect(markdown).toContain("Understanding Widgets");
    expect(markdown).toContain("[link](https://example.com)");
    expect(markdown).toContain("| A | B |");
    expect(markdown).not.toContain("Copyright 2024");
  });
});

describe("looksLikeHtml", () => {
  it("detects leading HTML tags", () => {
    expect(looksLikeHtml("  <!doctype html><html></html>")).toBe(true);
    expect(looksLikeHtml("<body>x</body>")).toBe(true);
    expect(looksLikeHtml("just text")).toBe(false);
  });
});

describe("isLowQualityOutput", () => {
  it("flags JS-gated short output", () => {
    expect(isLowQualityOutput("Please enable JavaScript to view this page.")).toBe(true);
  });

  it("flags navigation-heavy output", () => {
    const lines = Array.from({ length: 20 }, () => "Home").join("\n");
    expect(isLowQualityOutput(lines)).toBe(true);
  });

  it("accepts substantial prose", () => {
    const prose = Array.from(
      { length: 12 },
      (_value, index) =>
        `Paragraph ${index} with a sentence of reasonable length that carries meaning.`,
    ).join("\n");
    expect(isLowQualityOutput(prose)).toBe(false);
  });
});

describe("stripDataUriImages", () => {
  it("removes inline data-URI images and keeps alt text", () => {
    const input =
      "before ![alt](data:image/png;base64,AAAA) middle ![](data:image/gif;base64,BBBB) after";
    expect(stripDataUriImages(input)).toBe("before ![alt] middle  after");
  });
});
