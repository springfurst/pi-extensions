import { describe, expect, it } from "vitest";
import { buildResult } from "./types";

describe("buildResult", () => {
  it("does not cap handler output at a fixed size", () => {
    const md = "x".repeat(600_000);
    const result = buildResult(md, {
      url: "https://example.com/",
      method: "test",
      fetchedAt: "2026-10-10T00:00:00.000Z",
    });
    expect(result.content).toHaveLength(600_000);
    expect(result.truncated).toBe(false);
  });

  it("collapses blank runs and trims", () => {
    const result = buildResult("a\n\n\n\nb\n", {
      url: "https://example.com/",
      method: "test",
      fetchedAt: "2026-10-10T00:00:00.000Z",
    });
    expect(result.content).toBe("a\n\nb");
  });
});
