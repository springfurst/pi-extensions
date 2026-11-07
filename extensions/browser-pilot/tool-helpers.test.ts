import type { Page } from "puppeteer-core";
import { describe, expect, it } from "vitest";
import type { BrowserPilotSession } from "./session";
import { parseKeyCombo, resolveSelectValues, targetFor } from "./tool-helpers";
import type { ManagedTab } from "./types";
import { BrowserPilotError } from "./types";

function sessionWithRef(tab: number): BrowserPilotSession {
  return {
    refs: new Map([["e1", { selector: 'pierce/[data-pi-ref="e1"]', snapshot: 1, tab }]]),
  } as unknown as BrowserPilotSession;
}

function tab(handle: number): ManagedTab {
  const page = {} as Page;
  return {
    handle,
    targetId: `target-${handle}`,
    page,
    owned: true,
    lastUsed: 0,
    console: [],
    network: [],
  };
}

describe("targetFor", () => {
  it("rejects a ref from another tab", () => {
    expect(() => targetFor(sessionWithRef(1), tab(2), { action: "click", ref: "e1" })).toThrow(
      BrowserPilotError,
    );
    expect(() => targetFor(sessionWithRef(1), tab(2), { action: "click", ref: "e1" })).toThrow(
      /belongs to tab 1, not tab 2/,
    );
  });

  it("resolves a ref in the current tab", () => {
    const current = tab(2);
    expect(targetFor(sessionWithRef(2), current, { action: "click", ref: "e1" })).toBe(
      current.page,
    );
  });

  it("rejects an unknown ref", () => {
    expect(() => targetFor(sessionWithRef(1), tab(1), { action: "click", ref: "e9" })).toThrow(
      /not known/,
    );
  });
});

describe("parseKeyCombo", () => {
  it("treats a bare key as the key itself", () => {
    expect(parseKeyCombo("Enter")).toEqual({ modifiers: [], key: "Enter" });
  });

  it("splits modifiers from the base key", () => {
    expect(parseKeyCombo("Control+A")).toEqual({ modifiers: ["Control"], key: "A" });
    expect(parseKeyCombo("Shift+Control+Tab")).toEqual({
      modifiers: ["Shift", "Control"],
      key: "Tab",
    });
  });

  it("accepts alternate modifier spellings and ignores duplicates", () => {
    expect(parseKeyCombo("cmd+k")).toEqual({ modifiers: ["Meta"], key: "k" });
    expect(parseKeyCombo("Ctrl+Control+A")).toEqual({ modifiers: ["Control"], key: "A" });
  });

  it("rejects an unknown modifier with a hint", () => {
    expect(() => parseKeyCombo("Hyper+A")).toThrow(/Unknown modifier "Hyper"/);
    try {
      parseKeyCombo("Hyper+A");
    } catch (error) {
      expect((error as BrowserPilotError).hint).toContain("Control");
    }
  });

  it("rejects an empty combination", () => {
    expect(() => parseKeyCombo("  ")).toThrow(/requires a key/);
  });
});

describe("resolveSelectValues", () => {
  const options = [
    { value: "a", label: "Alpha", text: "Alpha" },
    { value: "b", label: "Beta", text: "Beta " },
    { value: "c", label: "", text: "Gamma" },
  ];

  it("matches option values first", () => {
    expect(resolveSelectValues(options, ["b"])).toEqual({ values: ["b"], missing: [] });
  });

  it("falls back to labels and visible text", () => {
    expect(resolveSelectValues(options, ["Alpha"])).toEqual({ values: ["a"], missing: [] });
    expect(resolveSelectValues(options, ["Gamma"])).toEqual({ values: ["c"], missing: [] });
    expect(resolveSelectValues(options, [" Beta "])).toEqual({ values: ["b"], missing: [] });
  });

  it("reports requests that match nothing", () => {
    expect(resolveSelectValues(options, ["Alpha", "Delta"])).toEqual({
      values: ["a"],
      missing: ["Delta"],
    });
  });

  it("deduplicates options requested twice", () => {
    expect(resolveSelectValues(options, ["a", "Alpha"])).toEqual({ values: ["a"], missing: [] });
  });
});
