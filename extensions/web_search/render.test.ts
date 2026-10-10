import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import extension from "./index";
import { renderSearchCall, renderSearchResult } from "./render";
import type { WebSearchDetails } from "./tool";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

describe("web_search renderers", () => {
  it("renders the call line", () => {
    const component = renderSearchCall({ query: "rust async", recency: "week" }, theme);
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("web_search rust async");
    expect(rendered).toContain("recency:week");
  });

  it("renders sources from details, the shape pi passes to renderResult", () => {
    const details: WebSearchDetails = {
      query: "rust",
      provider: "public",
      engines: ["duckduckgo"],
      notes: [],
      sources: [
        { title: "A", url: "https://a.example" },
        { title: "B", url: "https://b.example" },
      ],
    };
    // pi passes `{ content, details }`; `structuredContent` is not forwarded.
    const component = renderSearchResult(
      { details, content: [{ type: "text", text: "[1] A\n[2] B" }] },
      { expanded: false, isPartial: false },
      theme,
    );
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("2 sources");
    expect(rendered).toContain("duckduckgo");
    expect(rendered).toContain("[1] A");
    expect(rendered).toContain("[2] B");
  });
});

describe("web_search extension", () => {
  it("registers the web_search tool", () => {
    const registered: Array<{ name: string }> = [];
    const pi = {
      registerTool: (tool: { name: string }) => registered.push(tool),
    } as unknown as ExtensionAPI;
    extension(pi);
    expect(registered.map((tool) => tool.name)).toEqual(["web_search"]);
  });
});
