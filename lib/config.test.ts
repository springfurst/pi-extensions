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
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SEARXNG_ENDPOINT;
  delete process.env.SEARXNG_TOKEN;
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
    process.env.SEARXNG_TOKEN = "env-token";
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

  it("ignores malformed browser values but keeps valid siblings", () => {
    writeGlobalConfig({ browser: { maxPages: 0, enabled: false, noSandbox: "yes" } });
    const config = loadConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.browser.maxPages).toBe(DEFAULT_CONFIG.browser.maxPages);
    expect(config.browser.enabled).toBe(false);
    expect(config.browser.noSandbox).toBe(false);
  });
});
