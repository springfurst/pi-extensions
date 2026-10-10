import { describe, expect, it } from "vitest";
import {
  applyLineSelector,
  formatSelector,
  parseReadUrlTarget,
  type ParsedSelector,
} from "./selector";

describe("parseReadUrlTarget", () => {
  it("returns null for non-URL paths", () => {
    expect(parseReadUrlTarget("/etc/hosts")).toBeNull();
    expect(parseReadUrlTarget("relative/file.ts")).toBeNull();
  });

  it("returns a bare URL with no selector", () => {
    expect(parseReadUrlTarget("https://example.com/foo")).toEqual({
      path: "https://example.com/foo",
      sel: { kind: "none" },
    });
  });

  it("peels :raw", () => {
    expect(parseReadUrlTarget("https://example.com/foo:raw")).toEqual({
      path: "https://example.com/foo",
      sel: { kind: "raw" },
    });
  });

  it("peels a single line range", () => {
    expect(parseReadUrlTarget("https://example.com/foo:50-100")).toEqual({
      path: "https://example.com/foo",
      sel: { kind: "lines", ranges: [{ startLine: 50, endLine: 100 }], raw: false },
    });
    expect(parseReadUrlTarget("https://example.com/foo:50+10")).toEqual({
      path: "https://example.com/foo",
      sel: { kind: "lines", ranges: [{ startLine: 50, endLine: 59 }], raw: false },
    });
    expect(parseReadUrlTarget("https://example.com/foo:50")).toEqual({
      path: "https://example.com/foo",
      sel: { kind: "lines", ranges: [{ startLine: 50, endLine: undefined }], raw: false },
    });
  });

  it("peels a tail selector, alone or with raw", () => {
    expect(parseReadUrlTarget("https://example.com/foo:-60")).toEqual({
      path: "https://example.com/foo",
      sel: { kind: "tail", count: 60, raw: false },
    });
    expect(parseReadUrlTarget("https://example.com/foo:raw:-60")).toEqual({
      path: "https://example.com/foo",
      sel: { kind: "tail", count: 60, raw: true },
    });
  });

  it("peels multi-range selectors", () => {
    expect(parseReadUrlTarget("https://example.com/foo:5-10,20-30")).toEqual({
      path: "https://example.com/foo",
      sel: {
        kind: "lines",
        ranges: [
          { startLine: 5, endLine: 10 },
          { startLine: 20, endLine: 30 },
        ],
        raw: false,
      },
    });
  });

  it("peels raw + range combos in both orders", () => {
    const sel: ParsedSelector = {
      kind: "lines",
      ranges: [{ startLine: 1, endLine: 120 }],
      raw: true,
    };
    expect(parseReadUrlTarget("https://example.com/foo:raw:1-120")).toEqual({
      path: "https://example.com/foo",
      sel,
    });
    expect(parseReadUrlTarget("https://example.com/foo:1-120:raw")).toEqual({
      path: "https://example.com/foo",
      sel,
    });
  });

  it("rejects two range groups on the same URL", () => {
    expect(() => parseReadUrlTarget("https://example.com/foo:5-10:20-30")).toThrow(/range groups/);
    expect(() => parseReadUrlTarget("https://example.com/foo:5-10:-30")).toThrow(/range groups/);
  });

  it("leaves URL ports intact", () => {
    expect(parseReadUrlTarget("https://example.com:8080/foo")).toEqual({
      path: "https://example.com:8080/foo",
      sel: { kind: "none" },
    });
    expect(parseReadUrlTarget("https://example.com:8080/foo:raw")).toEqual({
      path: "https://example.com:8080/foo",
      sel: { kind: "raw" },
    });
  });

  it("treats trailing-colon selectors that do not parse as part of the URL", () => {
    expect(parseReadUrlTarget("https://example.com/foo:abc")).toEqual({
      path: "https://example.com/foo:abc",
      sel: { kind: "none" },
    });
  });

  it("supports the host:port/ escape for naked-host selectors", () => {
    expect(parseReadUrlTarget("https://example.com/:80")).toEqual({
      path: "https://example.com/",
      sel: { kind: "lines", ranges: [{ startLine: 80, endLine: undefined }], raw: false },
    });
  });

  it("repairs a collapsed scheme while still peeling selectors", () => {
    expect(parseReadUrlTarget("https:/example.com/foo:50-100")).toEqual({
      path: "https://example.com/foo",
      sel: { kind: "lines", ranges: [{ startLine: 50, endLine: 100 }], raw: false },
    });
  });
});

describe("applyLineSelector", () => {
  const content = "one\ntwo\nthree\nfour\nfive";

  it("returns the content for no selector", () => {
    expect(applyLineSelector(content, { kind: "none" })).toBe(content);
    expect(applyLineSelector(content, { kind: "raw" })).toBe(content);
  });

  it("slices ranges and merges output", () => {
    expect(
      applyLineSelector(content, { kind: "lines", ranges: [{ startLine: 2, endLine: 3 }] }),
    ).toBe("two\nthree");
    expect(
      applyLineSelector(content, {
        kind: "lines",
        ranges: [
          { startLine: 1, endLine: 1 },
          { startLine: 4, endLine: 5 },
        ],
      }),
    ).toBe("one\nfour\nfive");
  });

  it("supports open-ended and tail selectors", () => {
    expect(
      applyLineSelector(content, { kind: "lines", ranges: [{ startLine: 3, endLine: undefined }] }),
    ).toBe("three\nfour\nfive");
    expect(applyLineSelector(content, { kind: "tail", count: 2 })).toBe("four\nfive");
  });
});

describe("formatSelector", () => {
  it("renders each selector shape", () => {
    expect(formatSelector({ kind: "none" })).toBeUndefined();
    expect(formatSelector({ kind: "raw" })).toBe(":raw");
    expect(formatSelector({ kind: "tail", count: 60 })).toBe(":-60");
    expect(formatSelector({ kind: "tail", count: 60, raw: true })).toBe(":raw:-60");
    expect(formatSelector({ kind: "lines", ranges: [{ startLine: 5, endLine: 10 }] })).toBe(
      ":5-10",
    );
    expect(formatSelector({ kind: "lines", ranges: [{ startLine: 5, endLine: undefined }] })).toBe(
      ":5-",
    );
    expect(
      formatSelector({
        kind: "lines",
        ranges: [
          { startLine: 5, endLine: 10 },
          { startLine: 20, endLine: 30 },
        ],
      }),
    ).toBe(":5-10,20-30");
  });
});
