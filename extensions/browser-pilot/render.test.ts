import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderPilotCall, renderPilotResult } from "./render";
import type { BrowserPilotCall, BrowserPilotDetails } from "./types";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

const keyHint = (_keybinding: string, description: string) => `ctrl+o ${description}`;

function lines(component: { render(width: number): string[] }, width = 200): string {
  return component
    .render(width)
    .map((line) => line.trimEnd())
    .join("\n");
}

function renderCall(call: BrowserPilotCall, expanded = false): string {
  const state: Record<string, unknown> = {};
  return lines(
    renderPilotCall(call, theme, {
      args: call,
      expanded,
      state,
      keyHint,
    }),
  );
}

function render(
  details: BrowserPilotDetails,
  body: string,
  expanded = false,
  call?: BrowserPilotCall,
  argsExpanded = false,
): string {
  return lines(
    renderPilotResult(
      { details, content: [{ type: "text", text: body }] },
      { expanded, isPartial: false },
      theme,
      {
        args: call,
        expanded,
        state: { argsExpanded },
        keyHint,
      },
    ),
  );
}

describe("browser-pilot renderers", () => {
  it("shows every argument in the collapsed call, not just a curated subset", () => {
    const line = renderCall({
      action: "click",
      params: { ref: "e5", tab: 2, button: "right", click_count: 2 },
    });
    expect(line).toContain("browser-pilot click");
    expect(line).toContain("ref=e5");
    expect(line).toContain("tab=2");
    expect(line).toContain('button="right"');
    expect(line).toContain("click_count=2");
  });

  it("shows a text_env source without its value", () => {
    const line = renderCall({ action: "type", params: { ref: "e3", text_env: "SITE_PASSWORD" } });
    expect(line).toContain("text_env=$SITE_PASSWORD");
  });

  it("shortens a long URL in the collapsed call", () => {
    const long = `https://www.google.com/search?q=${"x".repeat(200)}`;
    const line = renderCall({ action: "open", params: { url: long } });
    expect(line).not.toContain("x".repeat(50));
    expect(line).toContain("?…");
  });

  it("truncates long collapsed arguments but keeps the full value when expanded", () => {
    const expression = "await fetch('/api/items').then((response) => response.json())";
    const call: BrowserPilotCall = { action: "eval", params: { expression } };
    const collapsed = renderCall(call);
    expect(collapsed).toContain("expression=");
    expect(collapsed).toContain("…");
    expect(collapsed).not.toContain(expression);

    const expanded = renderCall(call, true);
    expect(expanded).toContain("Arguments");
    expect(expanded).toContain("expression");
    expect(expanded).toContain(expression);
  });

  it("marks the call arguments as shown when the call is expanded", () => {
    const call: BrowserPilotCall = { action: "click", params: { ref: "e5" } };
    const state: Record<string, unknown> = {};
    lines(renderPilotCall(call, theme, { args: call, expanded: true, state, keyHint }));
    expect(state.argsExpanded).toBe(true);
  });

  it("shows the subject, preview, URL, and expansion hint in a collapsed result", () => {
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
    const renderedLines = rendered.split("\n");
    expect(renderedLines[0]).toContain("click");
    expect(renderedLines[0]).toContain("tab 1");
    expect(renderedLines[1]).toBe('button "Sign in"');
    expect(renderedLines[2]).toBe("selected US");
    expect(renderedLines[3]).toContain("https://example.com/login");
    expect(rendered).toContain("ctrl+o to expand");
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
    expect(fallback.length).toBeLessThanOrEqual(160);
  });

  it("shows the whole body when expanded instead of stopping at 24 lines", () => {
    const body = Array.from({ length: 60 }, (_, index) => `console line ${index + 1}`).join("\n");
    const expanded = render(
      { action: "console", tab: 1 },
      `Tab 1 · https://example.com/\n\n${body}`,
      true,
    );
    expect(expanded).toContain("console line 1");
    expect(expanded).toContain("console line 60");
  });

  it("shows full arguments and output when the result is expanded", () => {
    const call: BrowserPilotCall = { action: "eval", params: { expression: "document.title" } };
    const expanded = render(
      { action: "eval", tab: 1, resultType: "string", chars: 15 },
      'Tab 1 · https://example.com/\nResult: string\n\n"Example Domain"',
      true,
      call,
    );
    expect(expanded).toContain("Arguments");
    expect(expanded).toContain("expression");
    expect(expanded).toContain("document.title");
    expect(expanded).toContain("Output");
    expect(expanded).toContain('"Example Domain"');
    expect(expanded).not.toContain("Result: string");
  });

  it("previews the eval result instead of repeating the expression", () => {
    const call: BrowserPilotCall = { action: "eval", params: { expression: "document.title" } };
    const rendered = render(
      { action: "eval", tab: 1, resultType: "string", chars: 15 },
      'Tab 1 · https://example.com/\nResult: string\n\n"Example Domain"',
      false,
      call,
    );
    expect(rendered).toContain('"Example Domain"');
    expect(rendered).not.toContain("document.title");
  });

  it("does not repeat arguments when the expanded call already showed them", () => {
    const call: BrowserPilotCall = { action: "click", params: { ref: "e5" } };
    const expanded = render(
      { action: "click", tab: 1, subject: 'button "Sign in"' },
      "Tab 1 · https://example.com/\nClicked ref e5.",
      true,
      call,
      true,
    );
    expect(expanded).not.toContain("Arguments");
    expect(expanded).toContain("Output");
    expect(expanded).toContain("Clicked ref e5.");
  });

  it("formats an eval object result as JSON", () => {
    const expanded = render(
      { action: "eval", tab: 1, resultType: "object", chars: 14 },
      'Tab 1 · https://example.com/\nResult: object\n\n{\n  "a": 1,\n  "b": [2, 3]\n}',
      true,
    );
    expect(expanded).toContain('"a": 1');
    expect(expanded).toContain('"b": [2, 3]');
  });

  it("renders read markdown without repeating its metadata line", () => {
    const expanded = render(
      { action: "read", tab: 1, format: "markdown", chars: 20 },
      "Tab 1 · https://example.com/\nFormat: markdown · 20 characters\n\n# Example Domain\n\nBody text.",
      true,
    );
    expect(expanded).toContain("Example Domain");
    expect(expanded).toContain("Body text.");
    expect(expanded).not.toContain("Format: markdown");
  });

  it("shortens the result URL", () => {
    const long = `https://example.com/path?${"param=value&".repeat(40)}`;
    const rendered = render({ action: "open", tab: 1, url: long }, "body");
    expect(rendered).toContain("?…");
    expect(rendered.split("\n").every((line) => line.length <= 200)).toBe(true);
  });

  it("renders errors in the error style and reveals details when expanded", () => {
    const body = "Unknown key\n\nHint: use a valid key\n\nCurrent: Tab 1";
    const collapsed = render({ action: "press", error: "Unknown key" }, body, false, {
      action: "press",
      params: { key: "NotAKey" },
    });
    expect(collapsed).toContain("Unknown key");
    expect(collapsed).toContain("Hint: use a valid key");
    expect(collapsed).toContain("ctrl+o to expand");

    const expanded = render({ action: "press", error: "Unknown key" }, body, true, {
      action: "press",
      params: { key: "NotAKey" },
    });
    expect(expanded).toContain("Arguments");
    expect(expanded).toContain("NotAKey");
    expect(expanded).toContain("Hint: use a valid key");
    expect(expanded).toContain("Current: Tab 1");
  });

  it("shows a partial result without arguments", () => {
    const component = renderPilotResult(
      {
        details: { action: "wait", tab: 1 },
        content: [{ type: "text", text: "Waiting for human... 5s\nmore" }],
      },
      { expanded: false, isPartial: true },
      theme,
      { args: { action: "wait", params: { until: "human" } }, keyHint },
    );
    expect(lines(component)).toBe("Waiting for human... 5s");
  });
});
