import { describe, expect, it } from "vitest";
import {
  DEFAULT_BLOCKING_CONFIG,
  DEFAULT_POLITENESS_CONFIG,
  DEFAULT_RUNTIME_CONFIG,
  mergeWebSections,
} from "./config";

describe("mergeWebSections", () => {
  it("returns the built-in defaults with no config files", () => {
    const config = mergeWebSections(undefined, undefined);
    expect(config).toEqual({
      runtime: DEFAULT_RUNTIME_CONFIG,
      politeness: DEFAULT_POLITENESS_CONFIG,
      hosts: {},
      blocking: DEFAULT_BLOCKING_CONFIG,
    });
  });

  it("merges global values over the defaults", () => {
    const config = mergeWebSections(
      {
        runtime: { profile: "work", maxPages: 8 },
        politeness: { robots: "strict", human: "transparent" },
        blocking: { images: "off" },
      },
      undefined,
    );
    expect(config.runtime.profile).toBe("work");
    expect(config.runtime.maxPages).toBe(8);
    expect(config.runtime.attach).toBe("auto");
    expect(config.politeness.robots).toBe("strict");
    expect(config.politeness.human).toBe("transparent");
    expect(config.politeness.tier).toBe("polite");
    expect(config.blocking.images).toBe("off");
    expect(config.blocking.fonts).toBe("third-party");
  });

  it("lets the project file override the global file per field", () => {
    const config = mergeWebSections(
      { runtime: { profile: "work", isolation: "contexts" }, politeness: { tier: "evasive" } },
      { runtime: { profile: "project" }, politeness: { evasion: "on-block" } },
    );
    expect(config.runtime.profile).toBe("project");
    expect(config.runtime.isolation).toBe("contexts");
    expect(config.politeness.tier).toBe("evasive");
    expect(config.politeness.evasion).toBe("on-block");
  });

  it("merges per-host policies field by field across files", () => {
    const config = mergeWebSections(
      { hosts: { "github.com": { minIntervalMs: 500, robots: "strict" } } },
      { hosts: { "github.com": { minIntervalMs: 1000, tier: "evasive" } } },
    );
    expect(config.hosts["github.com"]).toEqual({
      minIntervalMs: 1000,
      robots: "strict",
      tier: "evasive",
    });
  });

  it("keeps hosts from both files", () => {
    const config = mergeWebSections(
      { hosts: { "arxiv.org": { minIntervalMs: 3000 } } },
      { hosts: { "example.com": { robots: "strict" } } },
    );
    expect(Object.keys(config.hosts).sort()).toEqual(["arxiv.org", "example.com"]);
  });

  it("normalizes host keys and drops keys that are not hosts", () => {
    const config = mergeWebSections(
      {
        hosts: {
          "Example.COM.": { minIntervalMs: 250 },
          "localhost:3000": { robots: "warn" },
          "https://invalid.example/path": { robots: "strict" },
          "": { robots: "strict" },
        },
      },
      undefined,
    );
    expect(config.hosts).toEqual({
      "example.com": { minIntervalMs: 250 },
      "localhost:3000": { robots: "warn" },
    });
  });

  it("merges hosts whose keys differ only in case", () => {
    const config = mergeWebSections(
      { hosts: { "Example.com": { robots: "strict" } } },
      { hosts: { "example.com": { minIntervalMs: 100 } } },
    );
    expect(config.hosts["example.com"]).toEqual({ robots: "strict", minIntervalMs: 100 });
  });

  it("keeps valid per-host fields and ignores malformed siblings", () => {
    const config = mergeWebSections(
      {
        hosts: {
          "example.com": { minIntervalMs: -5, robots: "maybe", tier: "polite", allow: "ads" },
        },
      },
      undefined,
    );
    expect(config.hosts["example.com"]).toEqual({ tier: "polite", allow: ["ads"] });
  });

  it("filters blocking categories to known names and removes duplicates", () => {
    const config = mergeWebSections(
      { hosts: { "example.com": { allow: ["ads", "ads", "telemetry", 7] } } },
      undefined,
    );
    expect(config.hosts["example.com"]?.allow).toEqual(["ads"]);
  });

  it("ignores malformed shared values but keeps valid siblings", () => {
    const config = mergeWebSections(
      {
        runtime: { profile: "  ", attach: "sometimes", isolation: "windows", maxPages: 0 },
        politeness: {
          robots: true,
          human: "ask",
          globalConcurrency: 2.7,
          globalRequestsPerSecond: -1,
          latencyWarningFactor: 1,
        },
        blocking: { ads: "always", media: "off" },
      },
      undefined,
    );
    expect(config.runtime).toEqual(DEFAULT_RUNTIME_CONFIG);
    expect(config.politeness.robots).toBe("warn");
    expect(config.politeness.human).toBe("hint");
    expect(config.politeness.globalConcurrency).toBe(2);
    expect(config.politeness.globalRequestsPerSecond).toBe(
      DEFAULT_POLITENESS_CONFIG.globalRequestsPerSecond,
    );
    expect(config.politeness.latencyWarningFactor).toBe(
      DEFAULT_POLITENESS_CONFIG.latencyWarningFactor,
    );
    expect(config.blocking.ads).toBe("third-party");
    expect(config.blocking.media).toBe("off");
  });

  it("falls back to defaults for sections that are not objects", () => {
    const config = mergeWebSections(
      { runtime: [], politeness: "strict", hosts: 7, blocking: null },
      { runtime: "work" },
    );
    expect(config.runtime).toEqual(DEFAULT_RUNTIME_CONFIG);
    expect(config.politeness).toEqual(DEFAULT_POLITENESS_CONFIG);
    expect(config.hosts).toEqual({});
    expect(config.blocking).toEqual(DEFAULT_BLOCKING_CONFIG);
  });

  it("ignores config roots that are not objects", () => {
    expect(() => mergeWebSections(["runtime"], "project")).not.toThrow();
    expect(mergeWebSections(null, 3)).toEqual({
      runtime: DEFAULT_RUNTIME_CONFIG,
      politeness: DEFAULT_POLITENESS_CONFIG,
      hosts: {},
      blocking: DEFAULT_BLOCKING_CONFIG,
    });
  });

  it("does not share mutable section objects with the defaults", () => {
    const first = mergeWebSections({ blocking: { images: "off" } }, undefined);
    const second = mergeWebSections(undefined, undefined);
    first.politeness.human = "disabled";
    first.hosts["example.com"] = { robots: "strict" };
    expect(second.politeness.human).toBe("hint");
    expect(second.hosts).toEqual({});
    expect(DEFAULT_POLITENESS_CONFIG.human).toBe("hint");
  });
});
