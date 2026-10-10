import { describe, expect, it } from "vitest";
import {
  decodeHtmlEntities,
  formatAge,
  formatBytes,
  formatCount,
  formatNumber,
  normalizeSearchText,
  truncate,
} from "./format";

describe("formatNumber", () => {
  it("uses K/M/B suffixes", () => {
    expect(formatNumber(999)).toBe("999");
    expect(formatNumber(1_500)).toBe("1.5K");
    expect(formatNumber(25_000)).toBe("25K");
    expect(formatNumber(1_500_000)).toBe("1.5M");
    expect(formatNumber(25_000_000)).toBe("25M");
    expect(formatNumber(1_500_000_000)).toBe("1.5B");
    expect(formatNumber(Number.NaN)).toBe("0");
  });
});

describe("formatBytes", () => {
  it("scales through KB/MB/GB", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(1536)).toBe("1.5KB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5MB");
  });
});

describe("truncate", () => {
  it("leaves short strings alone and appends an ellipsis", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello world", 8)).toBe("hello w…");
  });
});

describe("formatCount", () => {
  it("pluralizes labels", () => {
    expect(formatCount("file", 1)).toBe("1 file");
    expect(formatCount("file", 3)).toBe("3 files");
    expect(formatCount("matches", 2)).toBe("2 matches");
  });
});

describe("formatAge", () => {
  it("formats seconds into coarse buckets", () => {
    expect(formatAge(30)).toBe("just now");
    expect(formatAge(120)).toBe("2m ago");
    expect(formatAge(3 * 3600)).toBe("3h ago");
    expect(formatAge(2 * 86_400)).toBe("2d ago");
    expect(formatAge(60 * 86_400)).toBe("2mo ago");
    expect(formatAge(undefined)).toBe("");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes the common entities", () => {
    expect(decodeHtmlEntities("a &lt;b&gt; &amp; &quot;c&quot;&#39;s")).toBe('a <b> & "c"\'s');
  });
});

describe("normalizeSearchText", () => {
  it("collapses whitespace and rejects blank values", () => {
    expect(normalizeSearchText("  a\n\tb  ")).toBe("a b");
    expect(normalizeSearchText("   ")).toBeUndefined();
    expect(normalizeSearchText(42)).toBeUndefined();
  });
});
