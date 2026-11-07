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

  it("requires an expression or script path for eval", () => {
    expect(() => validateAction("eval", {})).toThrow(/expression or script_path/);
    expect(() => validateAction("eval", { expression: "1 + 1" })).not.toThrow();
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

  it("formats a usage block", () => {
    const usage = formatUsage("click");
    expect(usage).toContain("click —");
    expect(usage).toContain("Params:");
    expect(usage).toContain("Example:");
  });
});
