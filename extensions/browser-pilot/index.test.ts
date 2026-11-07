import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import browserPilotExtension from "./index";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "browser-pilot-index-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("browser-pilot extension entry", () => {
  it("registers one sequential tool and the shutdown hook", async () => {
    const tools: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    const pi = {
      registerTool: (tool: Record<string, unknown>) => tools.push(tool),
      on: (event: string) => events.push(event),
    } as unknown as ExtensionAPI;

    browserPilotExtension(pi);

    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name).toBe("browser-pilot");
    expect(tool.executionMode).toBe("sequential");
    expect(String(tool.description)).toContain('action:"help"');
    expect(JSON.stringify(tool.parameters)).toContain('"help"');
    expect(events).toContain("session_shutdown");
  });

  it("executes help through the registered tool context", async () => {
    const tools: Array<Record<string, unknown>> = [];
    const pi = {
      registerTool: (tool: Record<string, unknown>) => tools.push(tool),
      on: () => undefined,
    } as unknown as ExtensionAPI;
    browserPilotExtension(pi);

    const execute = tools[0].execute as (
      id: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>;

    const result = await execute("call-1", { action: "help" }, undefined, undefined, {
      cwd: tempDir(),
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionId: () => "index-test",
        getSessionFile: () => undefined,
        getSessionName: () => undefined,
      },
      mode: "text",
    });

    expect(result.content[0]?.text).toContain("browser-pilot actions");
  });
});
