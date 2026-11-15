import { describe, expect, it } from "vitest";
import { ACTION_NAMES, ACTIONS, formatUsage, renderHelp, validateAction } from "./actions";
import { BrowserPilotError } from "./types";

describe("action registry", () => {
  it("has a spec for every action", () => {
    for (const name of ACTION_NAMES) {
      expect(ACTIONS[name].name).toBe(name);
      expect(ACTIONS[name].summary.length).toBeGreaterThan(0);
      expect(ACTIONS[name].when.length).toBeGreaterThan(0);
      expect(ACTIONS[name].examples.length).toBeGreaterThan(0);
    }
  });

  it("renders a group-first catalog", () => {
    const help = renderHelp();
    expect(help).toContain("browser-pilot topics");
    expect(help).toContain("Discover the tool in three steps");
    expect(help).toContain('{action:"help", params:{group:"inspect"}}');
    expect(help).toContain('{action:"help", params:{action:"snapshot"}}');
    expect(help).toContain("Group");
    for (const group of [
      "Lifecycle",
      "Navigation",
      "Tabs",
      "Inspect",
      "Interact",
      "Wait",
      "State",
      "Batch",
    ]) {
      expect(help).toContain(group);
    }
    expect(help).not.toContain("Common workflows");
    expect(help).toContain("optional suggestions");
  });

  it("renders a group and one action", () => {
    const group = renderHelp({ group: "interact" });
    expect(group).toContain("click");
    expect(group).toContain("type");
    expect(group).toContain("Related groups:");
    const click = renderHelp({ action: "click" });
    expect(click).toContain("ref");
    expect(click).toContain("selector");
    expect(click).toContain("Use when:");
    expect(click).toContain("Examples:");
    expect(click).toContain("Related:");
    const help = renderHelp({ action: "help" });
    expect(help).toContain('{action:"help"}');
    expect(help).toContain('{action:"help",params:{group:"inspect"}}');
    expect(help).toContain('{action:"help",params:{action:"snapshot"}}');
  });

  it("rejects an unknown group or action", () => {
    expect(() => renderHelp({ group: "nope" })).toThrow(BrowserPilotError);
    expect(() => renderHelp({ action: "nope" })).toThrow(BrowserPilotError);
  });
});

describe("validateAction", () => {
  it("requires a target for click", () => {
    expect(() => validateAction("click", {})).toThrow(/ref or selector/);
    expect(() => validateAction("click", { ref: "e1" })).not.toThrow();
    expect(() => validateAction("click", { selector: "button" })).not.toThrow();
  });

  it("requires a URL or direction for navigate", () => {
    expect(() => validateAction("navigate", {})).toThrow(/requires url/);
    expect(() => validateAction("navigate", { url: "https://example.com" })).not.toThrow();
    expect(() => validateAction("navigate", { direction: "back" })).not.toThrow();
  });

  it("requires exactly one text source for type", () => {
    expect(() => validateAction("type", { ref: "e1" })).toThrow(/exactly one/);
    expect(() => validateAction("type", { ref: "e1", text: "a", text_file: "b" })).toThrow(
      /exactly one/,
    );
    expect(() => validateAction("type", { ref: "e1", text: "a" })).not.toThrow();
  });

  it("requires exactly one expression or script path for eval", () => {
    expect(() => validateAction("eval", {})).toThrow(/exactly one/);
    expect(() => validateAction("eval", { expression: "1 + 1" })).not.toThrow();
    expect(() => validateAction("eval", { script_path: "script.js" })).not.toThrow();
    expect(() => validateAction("eval", { expression: "1 + 1", script_path: "script.js" })).toThrow(
      /exactly one/,
    );
  });

  it("requires the payload for a specific wait", () => {
    expect(() => validateAction("wait", { until: "selector" })).toThrow(/requires selector/);
    expect(() => validateAction("wait", { until: "selector", selector: "main" })).not.toThrow();
    expect(() => validateAction("wait", { until: "human" })).not.toThrow();
  });

  it("requires a tab for tabs select and close", () => {
    expect(() => validateAction("tabs", { operation: "close" })).toThrow(/requires tab/);
    expect(() => validateAction("tabs", { operation: "close", tab: 1 })).not.toThrow();
    expect(() => validateAction("tabs", { operation: "list" })).not.toThrow();
  });

  it("requires a policy for dialog policy", () => {
    expect(() => validateAction("dialog", { operation: "policy" })).toThrow(/requires policy/);
    expect(() => validateAction("dialog", { operation: "policy", policy: "manual" })).not.toThrow();
  });

  it("validates connect and upload", () => {
    expect(() => validateAction("connect", {})).toThrow(/requires endpoint/);
    expect(() => validateAction("connect", { endpoint: "http://127.0.0.1:9222" })).not.toThrow();
    expect(() => validateAction("upload", { files: ["a.txt"] })).toThrow(/ref or selector/);
    expect(() => validateAction("upload", { ref: "e1", files: [] })).toThrow(/files array/);
    expect(() => validateAction("upload", { ref: "e1", files: ["a.txt"] })).not.toThrow();
  });

  it("validates cookie and storage operations", () => {
    expect(() => validateAction("cookies", { operation: "set", name: "a" })).toThrow(
      /name and value/,
    );
    expect(() => validateAction("cookies", { operation: "set", name: "a", value: "b" })).toThrow(
      /url or domain/,
    );
    expect(() =>
      validateAction("cookies", {
        operation: "set",
        name: "a",
        value: "b",
        url: "https://example.com",
      }),
    ).not.toThrow();
    expect(() => validateAction("storage", { operation: "get" })).toThrow(/requires key/);
    expect(() => validateAction("storage", { operation: "set", key: "a" })).toThrow(
      /key and value/,
    );
    expect(() => validateAction("storage", { operation: "clear" })).not.toThrow();
  });

  it("validates route and expect operations", () => {
    expect(() => validateAction("route", { operation: "add" })).toThrow(/route_action/);
    expect(() => validateAction("route", { operation: "remove" })).toThrow(/requires rule_id/);
    expect(() =>
      validateAction("route", { operation: "add", route_action: "abort", url_pattern: "*" }),
    ).not.toThrow();
    expect(() => validateAction("expect", {})).toThrow(/requires check/);
    expect(() => validateAction("expect", { check: "text", expected: "hi" })).not.toThrow();
    expect(() => validateAction("expect", { check: "value", expected: "x" })).toThrow(
      /requires ref or selector/,
    );
    expect(() =>
      validateAction("expect", { check: "attribute", ref: "e1", expected: "x" }),
    ).toThrow(/requires attribute/);
    expect(() =>
      validateAction("expect", {
        check: "attribute",
        ref: "e1",
        attribute: "href",
        expected: "x",
      }),
    ).not.toThrow();
  });

  it("validates steps", () => {
    expect(() => validateAction("steps", {})).toThrow(/steps/);
    expect(() => validateAction("steps", { steps: [] })).toThrow(/steps/);
    expect(() =>
      validateAction("steps", {
        steps: [{ action: "navigate", params: { url: "https://example.com" } }],
      }),
    ).not.toThrow();
    expect(() => validateAction("steps", { steps: [{ action: "steps", params: {} }] })).toThrow(
      /Nested steps/,
    );
    expect(() =>
      validateAction("steps", { steps: [{ action: "wait", params: { until: "bogus" } }] }),
    ).toThrow(/wait until must be one of/);
    expect(() =>
      validateAction("steps", {
        steps: [{ action: "click", params: { ref: "e1", button: "sideways" } }],
      }),
    ).toThrow(/click button must be one of/);
    expect(() =>
      validateAction("steps", {
        steps: [{ action: "dialog", params: { operation: "policy", policy: "ask" } }],
      }),
    ).toThrow(/dialog policy must be one of/);
  });

  it("rejects unknown parameters with the valid list", () => {
    expect(() => validateAction("read", { urls: "https://example.com" })).toThrow(
      /Unknown read parameter "urls"/,
    );
    try {
      validateAction("read", { urls: "https://example.com" });
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserPilotError);
      expect((error as BrowserPilotError).hint).toContain("Valid params:");
    }
  });

  it("validates help group and action targets", () => {
    expect(() => validateAction("help", { group: "inspect" })).not.toThrow();
    expect(() => validateAction("help", { action: "click" })).not.toThrow();
    expect(() => validateAction("help", { group: "inspect", action: "click" })).toThrow(/not both/);
    expect(() => validateAction("help", { group: "nope" })).toThrow(/Unknown help group/);
    expect(() => validateAction("help", { action: "nope" })).toThrow(/Unknown help action/);
  });

  it("formats a usage block", () => {
    const usage = formatUsage("click");
    expect(usage).toContain("click —");
    expect(usage).toContain("Use when:");
    expect(usage).toContain("Params:");
    expect(usage).toContain("Examples:");
  });
});
