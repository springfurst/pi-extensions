import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  USAGE_SCHEMA_VERSION,
  appendUsageRecord,
  createFileUsageLogger,
  expandTilde,
  resolveUsageDir,
  serializeUsageRecord,
  usageFilePath,
  type UsageRecord,
} from "./logging";

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "webtools-logging-"));
  cwd = join(root, "project");
  agentDir = join(root, "agent");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    schema: USAGE_SCHEMA_VERSION,
    timestamp: "2026-01-01T00:00:00.000Z",
    tool: "web_fetch",
    toolVersion: "0.1.0",
    piVersion: "1.1.0",
    cwd,
    durationMs: 5,
    outcome: "ok",
    ...overrides,
  };
}

describe("expandTilde", () => {
  it("expands a leading tilde and leaves other paths alone", () => {
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("~/logs")).toBe(join(homedir(), "logs"));
    expect(expandTilde("~other/logs")).toBe("~other/logs");
    expect(expandTilde("/abs/logs")).toBe("/abs/logs");
  });
});

describe("resolveUsageDir", () => {
  it("defaults under the agent directory", () => {
    expect(resolveUsageDir(cwd, agentDir, {})).toBe(join(agentDir, "web-tools", "usage"));
  });

  it("expands a tilde and resolves relative paths against cwd", () => {
    expect(resolveUsageDir(cwd, agentDir, { dir: "~/logs" })).toBe(join(homedir(), "logs"));
    expect(resolveUsageDir(cwd, agentDir, { dir: "logs" })).toBe(resolve(cwd, "logs"));
  });

  it("keeps absolute paths as-is", () => {
    const absolute = join(root, "elsewhere");
    expect(resolveUsageDir(cwd, agentDir, { dir: absolute })).toBe(absolute);
  });
});

describe("serializeUsageRecord", () => {
  it("emits one newline-terminated JSON line", () => {
    const line = serializeUsageRecord(record({ tool: "web_search" }));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({ tool: "web_search", schema: 1 });
  });
});

describe("appendUsageRecord", () => {
  it("creates parent directories and appends lines", () => {
    const file = join(root, "nested", "usage", "web_fetch.jsonl");
    appendUsageRecord(file, record({ durationMs: 1 }));
    appendUsageRecord(file, record({ durationMs: 2 }));
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ durationMs: 2 });
  });

  it("writes files with restrictive permissions", () => {
    if (process.platform === "win32") return;
    const file = join(root, "usage", "web_fetch.jsonl");
    appendUsageRecord(file, record());
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("swallows filesystem errors", () => {
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    expect(() => appendUsageRecord(join(blocker, "usage.jsonl"), record())).not.toThrow();
  });
});

describe("createFileUsageLogger", () => {
  it("writes each tool to its own file", () => {
    const logger = createFileUsageLogger({ cwd, agentDir, tool: "web_search", config: {} });
    logger.log(record({ tool: "web_search" }));
    const file = usageFilePath(join(agentDir, "web-tools", "usage"), "web_search");
    expect(JSON.parse(readFileSync(file, "utf-8"))).toMatchObject({ tool: "web_search" });
  });
});
