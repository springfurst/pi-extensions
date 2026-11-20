import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_PILOT_CONFIG, loadBrowserPilotConfig } from "./config";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "browser-pilot-config-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadBrowserPilotConfig", () => {
  it("returns defaults when no file exists", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.profile).toBe("shared");
    expect(config.headless).toBe("auto");
    expect(config.maxTabs).toBe(DEFAULT_BROWSER_PILOT_CONFIG.maxTabs);
    expect(config.logging.dir).toBe(join(agentDir, "browser-pilot", "logs"));
  });

  it("merges global and project files with project precedence", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    writeFileSync(
      join(agentDir, "browser-pilot.json"),
      JSON.stringify({ profile: "work", maxTabs: 4, headless: true }),
    );
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "browser-pilot.json"),
      JSON.stringify({ maxTabs: 6, logging: { enabled: true, outputs: "snippet" } }),
    );
    const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.profile).toBe("work");
    expect(config.maxTabs).toBe(6);
    expect(config.headless).toBe(true);
    expect(config.logging.enabled).toBe(true);
    expect(config.logging.outputs).toBe("snippet");
  });

  it("defaults to no local file access", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.allowLocalFiles).toBe(false);
    expect(config.localFileGlobs).toEqual([]);
  });

  it("reads local file access and its globs", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    writeFileSync(
      join(agentDir, "browser-pilot.json"),
      JSON.stringify({ allowLocalFiles: true, localFileGlobs: ["fixtures/**", "docs/*.html"] }),
    );
    const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.allowLocalFiles).toBe(true);
    expect(config.localFileGlobs).toEqual(["fixtures/**", "docs/*.html"]);
  });

  it("accepts a single glob string", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    writeFileSync(
      join(agentDir, "browser-pilot.json"),
      JSON.stringify({ allowLocalFiles: true, localFileGlobs: "fixtures/**" }),
    );
    const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.localFileGlobs).toEqual(["fixtures/**"]);
  });

  it("ignores project config when the project is untrusted", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "browser-pilot.json"), JSON.stringify({ maxTabs: 2 }));
    const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: false });
    expect(config.maxTabs).toBe(DEFAULT_BROWSER_PILOT_CONFIG.maxTabs);
  });

  it("merges a partial project viewport with the global viewport", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    writeFileSync(
      join(agentDir, "browser-pilot.json"),
      JSON.stringify({ viewport: { width: 1200, height: 800 } }),
    );
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "browser-pilot.json"),
      JSON.stringify({ viewport: { width: 900 } }),
    );
    const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.viewport).toEqual({ width: 900, height: 800 });
  });

  it("keeps valid args and ignores invalid entries", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    writeFileSync(
      join(agentDir, "browser-pilot.json"),
      JSON.stringify({ args: ["--disable-gpu", "", 42, "--lang=en"] }),
    );
    const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.args).toEqual(["--disable-gpu", "--lang=en"]);
  });

  it("ignores malformed values without rejecting the file", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    writeFileSync(
      join(agentDir, "browser-pilot.json"),
      JSON.stringify({
        maxTabs: -1,
        headless: "yes",
        viewport: { width: "wide" },
        tabOverflow: "explode",
        logging: { outputs: "everything" },
      }),
    );
    const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.maxTabs).toBe(DEFAULT_BROWSER_PILOT_CONFIG.maxTabs);
    expect(config.headless).toBe("auto");
    expect(config.viewport).toEqual(DEFAULT_BROWSER_PILOT_CONFIG.viewport);
    expect(config.tabOverflow).toBe("nudge");
    expect(config.logging.outputs).toBe("summary");
  });

  it("reads profile and executable overrides from the environment", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    const config = loadBrowserPilotConfig(cwd, {
      agentDir,
      projectTrusted: true,
      env: {
        ...process.env,
        BROWSER_PILOT_PROFILE: "env-profile",
        BROWSER_PILOT_EXECUTABLE_PATH: "/tmp/chrome",
      },
    });
    expect(config.profile).toBe("env-profile");
    expect(config.executablePath).toBe("/tmp/chrome");
  });

  it("defaults the shared runtime, politeness, host, and blocking sections", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.runtime).toEqual(DEFAULT_BROWSER_PILOT_CONFIG.runtime);
    expect(config.politeness).toEqual(DEFAULT_BROWSER_PILOT_CONFIG.politeness);
    expect(config.hosts).toEqual({});
    expect(config.blocking).toEqual(DEFAULT_BROWSER_PILOT_CONFIG.blocking);
  });

  it("merges the shared sections across both files", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    writeFileSync(
      join(agentDir, "browser-pilot.json"),
      JSON.stringify({
        runtime: { profile: "work", isolation: "contexts" },
        politeness: { robots: "strict", human: "transparent" },
        hosts: { "github.com": { minIntervalMs: 500, robots: "strict" } },
        blocking: { images: "off" },
      }),
    );
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "browser-pilot.json"),
      JSON.stringify({
        runtime: { maxPages: 3 },
        politeness: { human: "disabled" },
        hosts: { "github.com": { minIntervalMs: 1200 } },
      }),
    );
    const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.runtime.profile).toBe("work");
    expect(config.runtime.isolation).toBe("contexts");
    expect(config.runtime.maxPages).toBe(3);
    expect(config.politeness.robots).toBe("strict");
    expect(config.politeness.human).toBe("disabled");
    expect(config.hosts["github.com"]).toEqual({ minIntervalMs: 1200, robots: "strict" });
    expect(config.blocking.images).toBe("off");
  });

  it("ignores shared sections from an untrusted project", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "browser-pilot.json"),
      JSON.stringify({ politeness: { human: "transparent" }, hosts: { "example.com": {} } }),
    );
    const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: false });
    expect(config.politeness).toEqual(DEFAULT_BROWSER_PILOT_CONFIG.politeness);
    expect(config.hosts).toEqual({});
  });

  it("ignores malformed shared values but keeps valid siblings", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    writeFileSync(
      join(agentDir, "browser-pilot.json"),
      JSON.stringify({
        runtime: { maxPages: -2, attach: "sometimes" },
        politeness: { latencyWarningFactor: 1, human: "ask" },
        blocking: { ads: "always", media: "off" },
      }),
    );
    const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: true });
    expect(config.runtime.maxPages).toBe(DEFAULT_BROWSER_PILOT_CONFIG.runtime.maxPages);
    expect(config.runtime.attach).toBe("auto");
    expect(config.politeness.latencyWarningFactor).toBe(
      DEFAULT_BROWSER_PILOT_CONFIG.politeness.latencyWarningFactor,
    );
    expect(config.politeness.human).toBe("hint");
    expect(config.blocking.ads).toBe("third-party");
    expect(config.blocking.media).toBe("off");
  });
});
