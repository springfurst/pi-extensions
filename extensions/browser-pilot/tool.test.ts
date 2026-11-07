import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_PILOT_CONFIG } from "./config";
import { disposeAllSessions } from "./session";
import {
  executeBrowserPilot,
  safeParams,
  summarizeOutput,
  type BrowserPilotToolResult,
} from "./tool";
import type { BrowserPilotConfig, BrowserPilotContext, BrowserPilotParams } from "./types";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "browser-pilot-tool-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await disposeAllSessions(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(agentDir: string, sessionId: string): BrowserPilotContext {
  return {
    cwd: tempDir(),
    agentDir,
    trusted: true,
    sessionId,
  };
}

function text(result: BrowserPilotToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function run(params: BrowserPilotParams, ctx: BrowserPilotContext) {
  return executeBrowserPilot(params, ctx);
}

describe("executeBrowserPilot", () => {
  it("serves help without a browser", async () => {
    const result = await run({ action: "help" }, context(tempDir(), "help-1"));
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("Each row is a group");
    expect(text(result)).toContain("snapshot");
  });

  it("serves per-action help", async () => {
    const result = await run({ action: "help", topic: "click" }, context(tempDir(), "help-2"));
    expect(text(result)).toContain("click —");
    expect(text(result)).toContain("ref");
  });

  it("reports status without launching Chrome", async () => {
    const result = await run({ action: "status" }, context(tempDir(), "status-1"));
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("Browser: not running");
  });

  it("does not launch Chrome for a tab list", async () => {
    const result = await run({ action: "tabs", op: "list" }, context(tempDir(), "tabs-1"));
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("No browser is running");
  });

  it("returns an actionable validation error", async () => {
    const result = await run({ action: "click" }, context(tempDir(), "invalid-1"));
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("click requires ref or selector");
    expect(text(result)).toContain("snapshot");
  });

  it("writes a usage record with the safe action envelope", async () => {
    const agentDir = tempDir();
    const logs = join(agentDir, "logs");
    writeFileSync(
      join(agentDir, "browser-pilot.json"),
      JSON.stringify({
        logging: { enabled: true, dir: logs, outputs: "summary" },
      }),
    );
    const result = await run({ action: "help" }, context(agentDir, "log-1"));
    expect(result.isError).toBeUndefined();

    const file = join(logs, "browser-pilot.jsonl");
    expect(existsSync(file)).toBe(true);
    const record = JSON.parse(readFileSync(file, "utf-8").trim()) as Record<string, unknown>;
    expect(record.tool).toBe("browser-pilot");
    expect(record.action).toBe("help");
    expect(record.outcome).toBe("ok");
    expect(record.params).toMatchObject({ action: "help" });
    expect(record.output).toMatchObject({ chars: expect.any(Number) });
  });
});

describe("safeParams", () => {
  const config: BrowserPilotConfig = {
    ...DEFAULT_BROWSER_PILOT_CONFIG,
    logging: {
      ...DEFAULT_BROWSER_PILOT_CONFIG.logging,
      includeSensitiveArgs: false,
      includeArgs: true,
    },
  };

  it("hashes typed text and eval source by default", () => {
    const textParams = safeParams({ action: "type", ref: "e1", text: "hunter2" }, config);
    expect(textParams.text).toMatchObject({ length: 7, sha256: expect.any(String) });
    expect(textParams.text).not.toBe("hunter2");

    const evalParams = safeParams({ action: "eval", expression: "document.cookie" }, config);
    expect(evalParams.expression).toMatchObject({ length: 15, sha256: expect.any(String) });
    expect(evalParams.expression).not.toBe("document.cookie");
  });

  it("omits URLs when includeArgs is false", () => {
    const withoutArgs = safeParams(
      { action: "navigate", url: "https://example.com/?token=secret" },
      { ...config, logging: { ...config.logging, includeArgs: false } },
    );
    expect(withoutArgs.url).toBeUndefined();
    expect(withoutArgs.action).toBe("navigate");
  });

  it("includes sensitive values only when explicitly enabled", () => {
    const enabled = safeParams(
      { action: "type", ref: "e1", text: "hunter2" },
      { ...config, logging: { ...config.logging, includeSensitiveArgs: true } },
    );
    expect(enabled.text).toBe("hunter2");
  });
});

describe("summarizeOutput", () => {
  const config: BrowserPilotConfig = {
    ...DEFAULT_BROWSER_PILOT_CONFIG,
    logging: {
      ...DEFAULT_BROWSER_PILOT_CONFIG.logging,
      outputs: "summary",
      maxOutputChars: 20,
    },
  };

  it("keeps tiny results intact", () => {
    expect(summarizeOutput("help", "short help", config)).toMatchObject({
      text: "short help",
      truncated: false,
    });
  });

  it("uses head and tail snippets for large results", () => {
    const result = summarizeOutput("read", "abcdefghijklmnopqrstuvwxyz", config);
    expect(result).toMatchObject({ head: "abcdefghij", tail: "qrstuvwxyz" });
    expect(result).not.toHaveProperty("text");
  });

  it("can disable output logging", () => {
    expect(
      summarizeOutput("read", "content", {
        ...config,
        logging: { ...config.logging, outputs: "none" },
      }),
    ).toBeUndefined();
  });
});
