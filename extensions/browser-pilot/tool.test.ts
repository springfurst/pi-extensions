import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_PILOT_CONFIG } from "./config";
import { disposeAllSessions } from "./session";
import {
  buildUsageRecord,
  executeBrowserPilot,
  safeParams,
  summarizeOutput,
  type BrowserPilotToolResult,
} from "./tool";
import type { BrowserPilotCall, BrowserPilotConfig, BrowserPilotContext } from "./types";

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

async function run(call: BrowserPilotCall, ctx: BrowserPilotContext) {
  return executeBrowserPilot(call, ctx);
}

describe("executeBrowserPilot", () => {
  it("serves help without a browser", async () => {
    const result = await run({ action: "help" }, context(tempDir(), "help-1"));
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("browser-pilot topics");
    expect(text(result)).toContain("snapshot");
  });

  it("serves per-action help", async () => {
    const result = await run(
      { action: "help", params: { action: "click" } },
      context(tempDir(), "help-2"),
    );
    expect(text(result)).toContain("click —");
    expect(text(result)).toContain("ref");
  });

  it("reports status without launching Chrome", async () => {
    const result = await run({ action: "status" }, context(tempDir(), "status-1"));
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("Browser: not running");
  });

  it("does not launch Chrome for a tab list", async () => {
    const result = await run(
      { action: "tabs", params: { op: "list" } },
      context(tempDir(), "tabs-1"),
    );
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

  it("redacts cookie, storage, and route payloads by default", () => {
    const cookie = safeParams(
      { action: "cookies", op: "set", name: "token", value: "secret" },
      config,
    );
    expect(cookie.value).toMatchObject({ length: 6, sha256: expect.any(String) });
    expect(cookie.value).not.toBe("secret");

    const route = safeParams(
      { action: "route", op: "add", route_action: "fulfill", body: "secret" },
      config,
    );
    expect(route.body).toMatchObject({ length: 6, sha256: expect.any(String) });

    const steps = safeParams(
      {
        action: "steps",
        steps: [{ action: "type", params: { ref: "e1", text: "secret" } }],
      },
      config,
    );
    expect(JSON.stringify(steps.steps)).not.toContain("secret");
  });
});

describe("buildUsageRecord", () => {
  const config: BrowserPilotConfig = {
    ...DEFAULT_BROWSER_PILOT_CONFIG,
    logging: { ...DEFAULT_BROWSER_PILOT_CONFIG.logging, includeArgs: true },
  };

  function record(includeArgs: boolean) {
    return buildUsageRecord({
      params: { action: "screenshot", path: "/tmp/shot.png" },
      config: { ...config, logging: { ...config.logging, includeArgs } },
      details: {
        action: "screenshot",
        url: "https://example.com/private",
        title: "Private",
        savedPath: "/tmp/shot.png",
        challenge: {
          type: "cloudflare",
          severity: "blocking",
          evidence: [],
          url: "https://example.com/private",
          title: "Private",
        },
      },
      outputText: "Screenshot: /tmp/shot.png",
      durationMs: 1,
      cwd: "/tmp",
      sessionId: "log-test",
    });
  }

  it("records URLs, titles, paths, and challenge data when includeArgs is true", () => {
    const result = record(true);
    expect(result.url).toBe("https://example.com/private");
    expect(result.title).toBe("Private");
    expect(result.savedPath).toBe("/tmp/shot.png");
    expect(result.challenge).toBeDefined();
    expect(result.output).toMatchObject({ text: "Screenshot: /tmp/shot.png" });
  });

  it("omits URLs, titles, paths, challenge data, and output text when includeArgs is false", () => {
    const result = record(false);
    expect(result.url).toBeUndefined();
    expect(result.title).toBeUndefined();
    expect(result.savedPath).toBeUndefined();
    expect(result.challenge).toBeUndefined();
    expect(result.output).toMatchObject({ redacted: "arguments" });
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

  it("uses head and tail snippets for large results when page content is allowed", () => {
    const result = summarizeOutput("read", "abcdefghijklmnopqrstuvwxyz", {
      ...config,
      logging: { ...config.logging, includeSensitiveArgs: true },
    });
    expect(result).toMatchObject({ head: "abcdefghij", tail: "qrstuvwxyz" });
    expect(result).not.toHaveProperty("text");
  });

  it("redacts page content unless sensitive arguments are enabled", () => {
    expect(summarizeOutput("read", "secret page text", config)).toMatchObject({
      redacted: "page content",
    });
    expect(summarizeOutput("network", "secret body", config)).toMatchObject({
      redacted: "page content",
    });
    expect(summarizeOutput("steps", "secret step output", config)).toMatchObject({
      redacted: "page content",
    });
  });

  it("never logs cookie, storage, or clipboard output", () => {
    for (const action of ["cookies", "storage", "clipboard"] as const) {
      const result = summarizeOutput(action, "token=secret", config);
      expect(result).toMatchObject({ redacted: "sensitive output" });
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  it("redacts output that can contain arguments when includeArgs is false", () => {
    const withoutArgs = {
      ...config,
      logging: { ...config.logging, includeArgs: false },
    };
    expect(summarizeOutput("open", "Tab 1 · https://example.com", withoutArgs)).toMatchObject({
      redacted: "arguments",
    });
    expect(summarizeOutput("help", "safe help text", withoutArgs)).toMatchObject({
      text: "safe help text",
    });
    expect(summarizeOutput("metrics", "Heap: 1MB", withoutArgs)).toMatchObject({
      text: "Heap: 1MB",
    });
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
