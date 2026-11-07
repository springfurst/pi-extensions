import { describe, expect, it } from "vitest";
import { ACTION_NAMES, ACTIONS, formatUsage, renderHelp, validateAction } from "./actions";
import { BrowserPilotError } from "./types";

describe("action registry", () => {
  it("has a spec for every action", () => {
    for (const name of ACTION_NAMES) {
      expect(ACTIONS[name].name).toBe(name);
      expect(ACTIONS[name].summary.length).toBeGreaterThan(0);
      expect(ACTIONS[name].examples.length).toBeGreaterThan(0);
    }
  });

  it("renders an explicit group/action catalog", () => {
    const help = renderHelp();
    expect(help).toContain("Each row is a group");
    expect(help).toContain("Group");
    expect(help).toContain("Actions");
    for (const name of ACTION_NAMES) {
      expect(help).toContain(name);
    }
    expect(help).toContain("Common workflows");
    expect(help).toContain("optional suggestions");
  });

  it("renders a group and one action", () => {
    expect(renderHelp("interact")).toContain("click");
    expect(renderHelp("interact")).toContain("type");
    const click = renderHelp("click");
    expect(click).toContain("ref");
    expect(click).toContain("selector");
    expect(click).toContain("Example:");
    expect(click).toContain("Related:");
  });

  it("rejects an unknown topic", () => {
    expect(() => renderHelp("nope")).toThrow(BrowserPilotError);
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
    expect(() => validateAction("wait", { for: "selector" })).toThrow(/requires selector/);
    expect(() => validateAction("wait", { for: "selector", selector: "main" })).not.toThrow();
    expect(() => validateAction("wait", { for: "human" })).not.toThrow();
  });

  it("requires a tab for tabs select and close", () => {
    expect(() => validateAction("tabs", { op: "close" })).toThrow(/requires tab/);
    expect(() => validateAction("tabs", { op: "close", tab: 1 })).not.toThrow();
    expect(() => validateAction("tabs", { op: "list" })).not.toThrow();
  });

  it("requires a policy for dialog policy", () => {
    expect(() => validateAction("dialog", { op: "policy" })).toThrow(/requires policy/);
    expect(() => validateAction("dialog", { op: "policy", policy: "manual" })).not.toThrow();
  });

  it("validates connect and upload", () => {
    expect(() => validateAction("connect", {})).toThrow(/requires endpoint/);
    expect(() => validateAction("connect", { endpoint: "http://127.0.0.1:9222" })).not.toThrow();
    expect(() => validateAction("upload", { files: ["a.txt"] })).toThrow(/ref or selector/);
    expect(() => validateAction("upload", { ref: "e1", files: [] })).toThrow(/files array/);
    expect(() => validateAction("upload", { ref: "e1", files: ["a.txt"] })).not.toThrow();
  });

  it("validates cookie and storage operations", () => {
    expect(() => validateAction("cookies", { op: "set", name: "a" })).toThrow(/name and value/);
    expect(() => validateAction("cookies", { op: "set", name: "a", value: "b" })).toThrow(
      /url or domain/,
    );
    expect(() =>
      validateAction("cookies", {
        op: "set",
        name: "a",
        value: "b",
        url: "https://example.com",
      }),
    ).not.toThrow();
    expect(() => validateAction("storage", { op: "get" })).toThrow(/requires key/);
    expect(() => validateAction("storage", { op: "set", key: "a" })).toThrow(/key and value/);
    expect(() => validateAction("storage", { op: "clear" })).not.toThrow();
  });

  it("validates route and expect operations", () => {
    expect(() => validateAction("route", { op: "add" })).toThrow(/route_action/);
    expect(() => validateAction("route", { op: "remove" })).toThrow(/requires id/);
    expect(() =>
      validateAction("route", { op: "add", route_action: "abort", url_pattern: "*" }),
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
      validateAction("steps", { steps: [{ action: "navigate", url: "https://example.com" }] }),
    ).not.toThrow();
    expect(() => validateAction("steps", { steps: [{ action: "steps", steps: [] }] })).toThrow(
      /Nested steps/,
    );
    expect(() => validateAction("steps", { steps: [{ action: "wait", for: "bogus" }] })).toThrow(
      /wait for must be one of/,
    );
    expect(() =>
      validateAction("steps", { steps: [{ action: "click", ref: "e1", button: "sideways" }] }),
    ).toThrow(/click button must be one of/);
    expect(() =>
      validateAction("steps", { steps: [{ action: "dialog", op: "policy", policy: "ask" }] }),
    ).toThrow(/dialog policy must be one of/);
  });

  it("formats a usage block", () => {
    const usage = formatUsage("click");
    expect(usage).toContain("click —");
    expect(usage).toContain("Params:");
    expect(usage).toContain("Example:");
  });
});
