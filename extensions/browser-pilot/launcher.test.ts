import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildChromeArgs,
  instanceRecordPath,
  pidAlive,
  readDevToolsActivePort,
  readInstanceRecord,
  resolveProfile,
  shouldRunHeadless,
  writeInstanceRecord,
} from "./launcher";
import type { InstanceRecord } from "./types";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "browser-pilot-launcher-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveProfile", () => {
  const agentDir = "/agent";
  const cwd = "/work";

  it("resolves the shared profile", () => {
    const profile = resolveProfile("shared", "s1", agentDir, cwd);
    expect(profile.key).toBe("shared");
    expect(profile.userDataDir).toBe(join(agentDir, "browser-pilot", "profiles", "shared"));
    expect(profile.persistent).toBe(true);
  });

  it("isolates the session profile and sanitizes the id", () => {
    const profile = resolveProfile("session", "a/b c", agentDir, cwd);
    expect(profile.key).toBe("session-a-b-c");
    expect(profile.userDataDir).toContain(join("profiles", "sessions", "a-b-c"));
    expect(profile.persistent).toBe(false);
  });

  it("resolves named profiles under the agent directory", () => {
    const profile = resolveProfile("work", "s1", agentDir, cwd);
    expect(profile.key).toBe("work");
    expect(profile.userDataDir).toBe(join(agentDir, "browser-pilot", "profiles", "work"));
  });

  it("accepts absolute paths", () => {
    const profile = resolveProfile("/tmp/custom-profile", "s1", agentDir, cwd);
    expect(profile.userDataDir).toBe("/tmp/custom-profile");
    expect(profile.persistent).toBe(true);
    expect(profile.key).toMatch(/^path-[a-f0-9]{16}$/);
  });
});

describe("instance records", () => {
  it("round-trips a valid record", () => {
    const dir = tempDir();
    const path = instanceRecordPath(dir, "shared");
    const record: InstanceRecord = {
      schema: 1,
      pid: 1234,
      port: 9222,
      wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/x",
      userDataDir: "/profile",
      executablePath: "/chrome",
      startedAt: "2026-01-01T00:00:00.000Z",
      ownerSessionId: "s1",
    };
    writeInstanceRecord(path, record);
    expect(readInstanceRecord(path)).toEqual(record);
  });

  it("ignores malformed records", () => {
    const dir = tempDir();
    const path = instanceRecordPath(dir, "shared");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json");
    expect(readInstanceRecord(path)).toBeUndefined();
  });

  it("rejects records with an unknown schema", () => {
    const dir = tempDir();
    const path = instanceRecordPath(dir, "shared");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ schema: 99 }));
    expect(readInstanceRecord(path)).toBeUndefined();
  });
});

describe("DevToolsActivePort", () => {
  it("parses the port and websocket path", () => {
    const dir = tempDir();
    const path = join(dir, "DevToolsActivePort");
    writeFileSync(path, "51234\n/devtools/browser/abc\n");
    expect(readDevToolsActivePort(path)).toEqual({
      port: 51234,
      wsEndpoint: "ws://127.0.0.1:51234/devtools/browser/abc",
    });
  });

  it("rejects malformed files", () => {
    const dir = tempDir();
    const path = join(dir, "DevToolsActivePort");
    writeFileSync(path, "not-a-port\nnope\n");
    expect(readDevToolsActivePort(path)).toBeUndefined();
  });
});

describe("buildChromeArgs", () => {
  it("uses port zero, a dedicated profile, and basic stealth", () => {
    const args = buildChromeArgs(
      {
        viewport: { width: 1200, height: 800 },
        stealth: "basic",
        locale: "en-US",
        noSandbox: true,
        args: ["--foo"],
      },
      "/profile",
      true,
    );
    expect(args).toContain("--remote-debugging-port=0");
    expect(args).toContain("--user-data-dir=/profile");
    expect(args).toContain("--headless=new");
    expect(args).toContain("--disable-blink-features=AutomationControlled");
    expect(args).toContain("--lang=en-US");
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--foo");
  });

  it("omits stealth and headless flags when disabled", () => {
    const args = buildChromeArgs(
      {
        viewport: { width: 1200, height: 800 },
        stealth: "off",
        noSandbox: false,
        args: [],
      },
      "/profile",
      false,
    );
    expect(args).not.toContain("--headless=new");
    expect(args).not.toContain("--disable-blink-features=AutomationControlled");
  });
});

describe("shouldRunHeadless", () => {
  it("honors explicit values", () => {
    expect(shouldRunHeadless({ headless: true }, "linux", {})).toBe(true);
    expect(shouldRunHeadless({ headless: false }, "linux", {})).toBe(false);
  });

  it("falls back to headless on a display-less Linux host", () => {
    expect(shouldRunHeadless({ headless: "auto" }, "linux", {})).toBe(true);
    expect(shouldRunHeadless({ headless: "auto" }, "linux", { DISPLAY: ":0" })).toBe(false);
  });

  it("is headful by default on Windows and macOS", () => {
    expect(shouldRunHeadless({ headless: "auto" }, "win32", {})).toBe(false);
    expect(shouldRunHeadless({ headless: "auto" }, "darwin", {})).toBe(false);
  });
});

describe("pidAlive", () => {
  it("sees the current process", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it("rejects invalid pids", () => {
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
  });
});
