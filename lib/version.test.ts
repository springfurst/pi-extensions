import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_VERSION } from "./version";

describe("TOOL_VERSION", () => {
  it("matches the package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
      version: string;
    };
    expect(TOOL_VERSION).toBe(pkg.version);
  });

  it("is a non-empty version string", () => {
    expect(TOOL_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
