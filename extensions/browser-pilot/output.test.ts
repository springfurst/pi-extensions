import { describe, expect, it } from "vitest";
import {
  capText,
  formatChallenge,
  formatTabs,
  hint,
  pageHeader,
  suggestedNext,
  truncationHint,
} from "./output";

describe("output helpers", () => {
  it("caps text and reports the original length", () => {
    expect(capText("abcdef", 3)).toEqual({ text: "abc", truncated: true, chars: 6 });
    expect(capText("abc", 3)).toEqual({ text: "abc", truncated: false, chars: 3 });
  });

  it("builds a page header", () => {
    expect(pageHeader(2, "https://example.com", "Example")).toBe(
      'Tab 2 · https://example.com · "Example"',
    );
    expect(pageHeader(1, "", "")).toBe("Tab 1 · about:blank");
  });

  it("labels hints as suggestions", () => {
    expect(hint("run snapshot")).toBe("Hint: run snapshot");
    expect(suggestedNext("read")).toBe("Suggested next: read");
  });

  it("formats tabs with the current marker and user ownership", () => {
    const text = formatTabs(
      [
        {
          handle: 1,
          targetId: "t1",
          url: "https://a.example",
          title: "A",
          current: true,
          owned: true,
          lastUsed: 1,
        },
        {
          handle: 2,
          targetId: "t2",
          url: "https://b.example",
          title: "B",
          current: false,
          owned: false,
          lastUsed: 2,
        },
      ],
      8,
    );
    expect(text).toContain("Tabs: 2/8");
    expect(text).toContain("* 1");
    expect(text).toContain("(user)");
  });

  it("formats a challenge", () => {
    const text = formatChallenge({
      type: "cloudflare",
      severity: "blocking",
      evidence: ["just a moment"],
      url: "https://example.com",
      title: "Just a moment",
    });
    expect(text).toContain("cloudflare blocking");
    expect(text).toContain("just a moment");
  });

  it("explains truncation and the escape hatch", () => {
    expect(truncationHint(100, 10, "/tmp/out.txt")).toContain("full output saved to /tmp/out.txt");
    expect(truncationHint(100, 10)).toContain("save_path");
    expect(truncationHint(100, 10, undefined, false)).toContain("use har");
    expect(truncationHint(100, 10, undefined, false)).not.toContain("save_path");
  });
});
