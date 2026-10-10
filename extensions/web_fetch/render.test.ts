import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import extension from "./index";
import { renderFetchCall, renderFetchResult, type WebFetchDetails } from "./render";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

describe("web_fetch renderers", () => {
  it("renders the call line", () => {
    const component = renderFetchCall({ url: "https://example.com/page" }, theme);
    expect(component.render(80).join("\n")).toContain("web_fetch https://example.com/page");
  });

  it("renders a result summary", () => {
    const details: WebFetchDetails = {
      url: "https://example.com/page",
      finalUrl: "https://example.com/page",
      contentType: "text/html",
      method: "readability",
      truncated: false,
      notes: [],
      selector: ":1-10",
    };
    const component = renderFetchResult(
      { details, content: [{ type: "text", text: "body line" }] },
      { expanded: false, isPartial: false },
      theme,
    );
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("readability");
    expect(rendered).toContain("https://example.com/page");
  });
});

describe("web_fetch extension", () => {
  it("registers the web_fetch tool", () => {
    const registered: Array<{ name: string }> = [];
    const pi = {
      registerTool: (tool: { name: string }) => registered.push(tool),
    } as unknown as ExtensionAPI;
    extension(pi);
    expect(registered.map((tool) => tool.name)).toEqual(["web_fetch"]);
  });
});
