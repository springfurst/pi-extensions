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

  it("ignores project config when the project is untrusted", () => {
    const agentDir = tempDir();
    const cwd = tempDir();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "browser-pilot.json"), JSON.stringify({ maxTabs: 2 }));
    const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: false });
    expect(config.maxTabs).toBe(DEFAULT_BROWSER_PILOT_CONFIG.maxTabs);
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
    const previousProfile = process.env.BROWSER_PILOT_PROFILE;
    const previousChrome = process.env.BROWSER_PILOT_EXECUTABLE_PATH;
    process.env.BROWSER_PILOT_PROFILE = "env-profile";
    process.env.BROWSER_PILOT_EXECUTABLE_PATH = "/tmp/chrome";
    try {
      const config = loadBrowserPilotConfig(cwd, { agentDir, projectTrusted: true });
      expect(config.profile).toBe("env-profile");
      expect(config.executablePath).toBe("/tmp/chrome");
    } finally {
      if (previousProfile === undefined) delete process.env.BROWSER_PILOT_PROFILE;
      else process.env.BROWSER_PILOT_PROFILE = previousProfile;
      if (previousChrome === undefined) delete process.env.BROWSER_PILOT_EXECUTABLE_PATH;
      else process.env.BROWSER_PILOT_EXECUTABLE_PATH = previousChrome;
    }
  });
});
