import type { Page } from "puppeteer-core";
import { describe, expect, it } from "vitest";
import type { BrowserPilotSession } from "./session";
import { targetFor } from "./tool-helpers";
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
