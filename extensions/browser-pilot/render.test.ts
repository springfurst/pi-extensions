import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderPilotCall, renderPilotResult } from "./render";
import type { BrowserPilotDetails } from "./types";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

/** Render a result and strip the padding the terminal component adds. */
function render(details: BrowserPilotDetails, body: string, expanded = false): string {
  return renderPilotResult(
    { details, content: [{ type: "text", text: body }] },
    { expanded, isPartial: false },
    theme,
  )
    .render(200)
    .map((line) => line.trimEnd())
    .join("\n");
}

describe("browser-pilot renderers", () => {
  it("shows the action with its target and arguments in the call line", () => {
    const line = renderPilotCall({ action: "click", params: { ref: "e5", tab: 2 } } as never, theme)
      .render(200)
      .join("\n")
      .trimEnd();
    expect(line).toContain("browser-pilot click");
    expect(line).toContain("e5");
    expect(line).toContain("tab 2");
  });

  it("shows typed text and a text_env source without its value", () => {
    expect(
      renderPilotCall({ action: "type", params: { ref: "e3", text: "hello" } } as never, theme)
        .render(200)
        .join("\n"),
    ).toContain('"hello"');
    const envLine = renderPilotCall(
      { action: "type", params: { ref: "e3", text_env: "SITE_PASSWORD" } } as never,
      theme,
    )
      .render(200)
      .join("\n");
    expect(envLine).toContain("$SITE_PASSWORD");
  });

  it("shortens a long URL in the call line", () => {
    const long = `https://www.google.com/search?q=${"x".repeat(200)}`;
    const line = renderPilotCall({ action: "open", params: { url: long } } as never, theme)
      .render(200)
      .join("\n");
    expect(line).not.toContain("x".repeat(50));
    expect(line).toContain("?…");
  });

  it("shows the subject and preview above the URL", () => {
    const rendered = render(
      {
        action: "click",
        tab: 1,
        url: "https://example.com/login",
        title: "Sign in",
        subject: 'button "Sign in"',
        preview: "selected US",
      },
      'Tab 1 · https://example.com/login · "Sign in"\nClicked ref e5.',
    );
    const lines = rendered.split("\n");
    expect(lines[0]).toContain("click");
    expect(lines[0]).toContain("tab 1");
    expect(lines[1]).toBe('button "Sign in"');
    expect(lines[2]).toBe("selected US");
    expect(lines[3]).toContain("https://example.com/login");
  });

  it("falls back to the first body line when no subject is set", () => {
    const rendered = render(
      { action: "scroll", tab: 1, url: "https://example.com/" },
      "Tab 1 · https://example.com/\nScroll: x=0 y=900 height=2355 viewport=768",
    );
    expect(rendered).toContain("Scroll: x=0 y=900");
  });

  it("collapses a long fallback line", () => {
    const rendered = render(
      { action: "console", tab: 1, url: "https://example.com/" },
      `Tab 1 · https://example.com/\n${"error line ".repeat(40)}`,
    );
    const fallback = rendered.split("\n")[1];
    expect(fallback.endsWith("…")).toBe(true);
    expect(fallback.length).toBeLessThanOrEqual(120);
  });

  it("keeps the whole body for expanded results without repeating the summary line", () => {
    const body = "Tab 1 · https://example.com/\nClicked ref e5.\nsecond line";
    const collapsed = render({ action: "click", tab: 1 }, body);
    expect(collapsed).toContain("Clicked ref e5.");
    const expanded = render({ action: "click", tab: 1 }, body, true);
    expect(expanded.split("\n").filter((line) => line === "Clicked ref e5.")).toHaveLength(1);
    expect(expanded).toContain("second line");
  });

  it("shortens the result URL", () => {
    const long = `https://example.com/path?${"param=value&".repeat(40)}`;
    const rendered = render({ action: "open", tab: 1, url: long }, "body");
    expect(rendered).toContain("?…");
    expect(rendered.split("\n").every((line) => line.length <= 200)).toBe(true);
  });

  it("renders errors in the error style", () => {
    const component = renderPilotResult(
      {
        details: { action: "press", error: "Unknown key" },
        content: [{ type: "text", text: "x" }],
      },
      { expanded: false, isPartial: false },
      theme,
    );
    expect(component.render(80).join("\n")).toContain("Unknown key");
  });
});
