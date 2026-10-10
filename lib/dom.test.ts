import { describe, expect, it } from "vitest";
import { parseDocument, parseXmlDocument } from "./dom";

describe("parseDocument", () => {
  it("parses HTML and supports queries", () => {
    const document = parseDocument("<html><body><p id='x'>hi</p><a href='/a'>A</a></body></html>");
    expect(document.querySelector("#x")?.textContent).toBe("hi");
    expect(document.querySelector("a")?.getAttribute("href")).toBe("/a");
  });
});

describe("parseXmlDocument", () => {
  it("keeps the text of non-void elements such as feed links", () => {
    const document = parseXmlDocument(
      "<rss><channel><title>Feed</title><item><title>Post</title><link>https://example.com/p</link></item></channel></rss>",
    );
    expect(document.querySelector("channel > title")?.textContent).toBe("Feed");
    expect(document.querySelector("item > link")?.textContent).toBe("https://example.com/p");
  });
});
