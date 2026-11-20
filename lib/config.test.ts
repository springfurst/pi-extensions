import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "./config";

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "webtools-config-"));
  cwd = join(root, "project");
  agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  // Environment fallbacks must come from the case, never from the shell.
  delete process.env.SEARXNG_ENDPOINT;
  delete process.env.SEARXNG_SECRET;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SEARXNG_ENDPOINT;
  delete process.env.SEARXNG_SECRET;
});

function writeProjectConfig(value: unknown): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "web-tools.json"), JSON.stringify(value));
}

function writeGlobalConfig(value: unknown): void {
  writeFileSync(join(agentDir, "web-tools.json"), JSON.stringify(value));
}

describe("loadConfig", () => {
  it("returns the built-in defaults when no file exists", () => {
    expect(loadConfig(cwd, { agentDir, projectTrusted: true })).toEqual(DEFAULT_CONFIG);
  });

  it("merges global values over defaults", () => {
    writeGlobalConfig({ fetch: { maxChars: 1234 }, search: { limit: 3 } });
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.fetch.maxChars).toBe(1234);
    expect(config.fetch.timeoutSeconds).toBe(DEFAULT_CONFIG.fetch.timeoutSeconds);
    expect(config.search.limit).toBe(3);
    expect(config.search.aggregate).toBe(true);
  });

  it("lets trusted project values override global ones", () => {
    writeGlobalConfig({ fetch: { maxChars: 1000 } });
    writeProjectConfig({ fetch: { maxChars: 2000, allowPrivateHosts: true } });
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.fetch.maxChars).toBe(2000);
    expect(config.fetch.allowPrivateHosts).toBe(true);
  });

  it("ignores the project file when the project is untrusted", () => {
    writeProjectConfig({ fetch: { maxChars: 2000, allowPrivateHosts: true } });
    const config = loadConfig(cwd, { agentDir, projectTrusted: false });
    expect(config.fetch.maxChars).toBe(DEFAULT_CONFIG.fetch.maxChars);
    expect(config.fetch.allowPrivateHosts).toBe(false);
  });

  it("ignores malformed values but keeps valid siblings", () => {
    writeGlobalConfig({
      fetch: { maxChars: "lots", allowPrivateHosts: true },
      search: { engines: ["duckduckgo", 5], limit: -1 },
    });
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.fetch.maxChars).toBe(DEFAULT_CONFIG.fetch.maxChars);
    expect(config.fetch.allowPrivateHosts).toBe(true);
    expect(config.search.engines).toEqual(DEFAULT_CONFIG.search.engines);
    expect(config.search.limit).toBe(DEFAULT_CONFIG.search.limit);
  });

  it("falls back to the environment for the SearXNG endpoint", () => {
    process.env.SEARXNG_ENDPOINT = "https://searx.example.org";
    process.env.SEARXNG_SECRET = "env-token";
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.searxng.endpoint).toBe("https://searx.example.org");
    expect(config.searxng.token).toBe("env-token");
  });

  it("prefers configured SearXNG values over the environment", () => {
    process.env.SEARXNG_ENDPOINT = "https://env.example.org";
    writeGlobalConfig({ searxng: { endpoint: "https://file.example.org" } });
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.searxng.endpoint).toBe("https://file.example.org");
  });

  it("merges browser values over the defaults", () => {
    writeGlobalConfig({ browser: { timeoutSeconds: 5, maxPages: 4 } });
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.browser.timeoutSeconds).toBe(5);
    expect(config.browser.maxPages).toBe(4);
    expect(config.browser.enabled).toBe(true);
    expect(config.browser.idleCloseSeconds).toBe(DEFAULT_CONFIG.browser.idleCloseSeconds);
  });

  it("lets trusted project browser values override global ones", () => {
    writeGlobalConfig({ browser: { executablePath: "/global/chrome" } });
    writeProjectConfig({ browser: { executablePath: "/project/chrome", noSandbox: true } });
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.browser.executablePath).toBe("/project/chrome");
    expect(config.browser.noSandbox).toBe(true);
  });

  it("merges a browser user data directory from global and project config", () => {
    expect(loadConfig(cwd, { agentDir, projectTrusted: true }).browser.userDataDir).toBeUndefined();
    writeGlobalConfig({ browser: { userDataDir: "/global/profile" } });
    expect(loadConfig(cwd, { agentDir, projectTrusted: true }).browser.userDataDir).toBe(
      "/global/profile",
    );
    writeProjectConfig({ browser: { userDataDir: "/project/profile" } });
    expect(loadConfig(cwd, { agentDir, projectTrusted: true }).browser.userDataDir).toBe(
      "/project/profile",
    );
  });

  it("preserves Windows user data directory separators", () => {
    writeGlobalConfig({ browser: { userDataDir: "C:\\Users\\me\\profile" } });
    expect(loadConfig(cwd, { agentDir, projectTrusted: true }).browser.userDataDir).toBe(
      "C:\\Users\\me\\profile",
    );
    writeProjectConfig({ browser: { userDataDir: "C:/Users/me/profile" } });
    expect(loadConfig(cwd, { agentDir, projectTrusted: true }).browser.userDataDir).toBe(
      "C:/Users/me/profile",
    );
  });

  it("ignores malformed browser values but keeps valid siblings", () => {
    writeGlobalConfig({ browser: { maxPages: 0, enabled: false, noSandbox: "yes" } });
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.browser.maxPages).toBe(DEFAULT_CONFIG.browser.maxPages);
    expect(config.browser.enabled).toBe(false);
    expect(config.browser.noSandbox).toBe(false);
  });

  it("ignores a blank browser user data directory", () => {
    writeGlobalConfig({ browser: { userDataDir: "   " } });
    expect(loadConfig(cwd, { agentDir, projectTrusted: true }).browser.userDataDir).toBeUndefined();
  });

  it("disables usage logging by default", () => {
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.logging.enabled).toBe(false);
    expect(config.logging.includeArgs).toBe(true);
    expect(config.logging.dir).toBeUndefined();
  });

  it("merges logging values from global and trusted project config", () => {
    writeGlobalConfig({ logging: { enabled: true, dir: "/global/usage" } });
    const global = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(global.logging.enabled).toBe(true);
    expect(global.logging.dir).toBe("/global/usage");

    writeProjectConfig({ logging: { includeArgs: false } });
    const merged = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(merged.logging.enabled).toBe(true);
    expect(merged.logging.includeArgs).toBe(false);
  });

  it("ignores logging values from an untrusted project", () => {
    writeProjectConfig({ logging: { enabled: true } });
    const config = loadConfig(cwd, { agentDir, projectTrusted: false });
    expect(config.logging.enabled).toBe(false);
  });

  it("ignores malformed logging values but keeps valid siblings", () => {
    writeGlobalConfig({ logging: { enabled: "yes", dir: "  ", includeArgs: false } });
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.logging.enabled).toBe(false);
    expect(config.logging.dir).toBeUndefined();
    expect(config.logging.includeArgs).toBe(false);
  });

  it("defaults the shared runtime, politeness, host, and blocking sections", () => {
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.runtime).toEqual(DEFAULT_CONFIG.runtime);
    expect(config.politeness).toEqual(DEFAULT_CONFIG.politeness);
    expect(config.hosts).toEqual({});
    expect(config.blocking).toEqual(DEFAULT_CONFIG.blocking);
  });

  it("reads the shared sections from the global file", () => {
    writeGlobalConfig({
      runtime: { profile: "work", attach: "off", isolation: "contexts", maxPages: 4 },
      politeness: { robots: "strict", globalConcurrency: 2, latencyWarningFactor: 3 },
      hosts: { "github.com": { minIntervalMs: 750, robots: "strict" } },
      blocking: { media: "off", ads: "off" },
    });
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.runtime).toEqual({
      profile: "work",
      attach: "off",
      isolation: "contexts",
      maxPages: 4,
      headless: "auto",
    });
    expect(config.politeness.robots).toBe("strict");
    expect(config.politeness.globalConcurrency).toBe(2);
    expect(config.politeness.latencyWarningFactor).toBe(3);
    expect(config.politeness.human).toBe("hint");
    expect(config.hosts["github.com"]).toEqual({ minIntervalMs: 750, robots: "strict" });
    expect(config.blocking.media).toBe("off");
    expect(config.blocking.images).toBe("third-party");
  });

  it("parses the shared runtime launch mode", () => {
    writeGlobalConfig({ runtime: { headless: true } });
    expect(loadConfig(cwd, { agentDir, projectTrusted: true }).runtime.headless).toBe(true);
    writeGlobalConfig({ runtime: { headless: "auto" } });
    expect(loadConfig(cwd, { agentDir, projectTrusted: true }).runtime.headless).toBe("auto");
    writeGlobalConfig({ runtime: { headless: "headful" } });
    expect(loadConfig(cwd, { agentDir, projectTrusted: true }).runtime.headless).toBe("auto");
  });

  it("lets the trusted project file override the shared sections", () => {
    writeGlobalConfig({
      runtime: { profile: "work" },
      politeness: { robots: "strict", human: "transparent" },
      hosts: { "github.com": { minIntervalMs: 500, robots: "strict" } },
      blocking: { images: "off" },
    });
    writeProjectConfig({
      runtime: { maxPages: 2 },
      politeness: { robots: "warn" },
      hosts: { "github.com": { minIntervalMs: 1500 } },
    });
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.runtime.profile).toBe("work");
    expect(config.runtime.maxPages).toBe(2);
    expect(config.politeness.robots).toBe("warn");
    expect(config.politeness.human).toBe("transparent");
    expect(config.hosts["github.com"]).toEqual({ minIntervalMs: 1500, robots: "strict" });
    expect(config.blocking.images).toBe("off");
  });

  it("ignores shared sections from an untrusted project", () => {
    writeProjectConfig({
      runtime: { profile: "project" },
      politeness: { human: "transparent" },
      hosts: { "example.com": { robots: "strict" } },
      blocking: { ads: "off" },
    });
    const config = loadConfig(cwd, { agentDir, projectTrusted: false });
    expect(config.runtime).toEqual(DEFAULT_CONFIG.runtime);
    expect(config.politeness).toEqual(DEFAULT_CONFIG.politeness);
    expect(config.hosts).toEqual({});
    expect(config.blocking).toEqual(DEFAULT_CONFIG.blocking);
  });

  it("ignores malformed shared values but keeps valid siblings", () => {
    writeGlobalConfig({
      runtime: { maxPages: 0, attach: "always" },
      politeness: { globalRequestsPerSecond: 0, human: "ask" },
      hosts: { "not a host": { robots: "strict" } },
      blocking: { fonts: "sometimes" },
    });
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.runtime.maxPages).toBe(DEFAULT_CONFIG.runtime.maxPages);
    expect(config.runtime.attach).toBe("auto");
    expect(config.politeness.globalRequestsPerSecond).toBe(
      DEFAULT_CONFIG.politeness.globalRequestsPerSecond,
    );
    expect(config.politeness.human).toBe("hint");
    expect(config.hosts).toEqual({});
    expect(config.blocking.fonts).toBe("third-party");
  });
});
