import { describe, expect, it } from "vitest";
import { matchesRoute, matchesUrlPattern } from "./route";

describe("route matching", () => {
  it("matches glob patterns", () => {
    expect(matchesUrlPattern("*", "https://example.com/a.png")).toBe(true);
    expect(matchesUrlPattern("*://*/*.png", "https://example.com/a.png")).toBe(true);
    expect(matchesUrlPattern("*://*/*.png", "https://example.com/a.js")).toBe(false);
    expect(matchesUrlPattern("https://example.com/api/*", "https://example.com/api/users")).toBe(
      true,
    );
  });

  it("matches an optional resource type", () => {
    const rule = {
      id: "r1",
      urlPattern: "*://*/*",
      action: "abort" as const,
      resourceType: "image",
    };
    expect(matchesRoute(rule, "https://example.com/a.png", "image")).toBe(true);
    expect(matchesRoute(rule, "https://example.com/a.png", "script")).toBe(false);
    expect(
      matchesRoute({ ...rule, resourceType: undefined }, "https://example.com/a.js", "script"),
    ).toBe(true);
  });
});
