import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "../web_fetch/__fixtures__/test-server";
import { disposeAllSessions, disposeAllSessionsSync } from "./session";
import { executeBrowserPilot, type BrowserPilotToolResult } from "./tool";
import type { BrowserPilotContext, BrowserPilotParams } from "./types";

const PAGE = `<!doctype html><html><head><title>Pilot Test</title></head><body>
<h1>Pilot Test</h1>
<a href="/article">Article</a>
<label>Name <input id="name" name="name" placeholder="Your name"></label>
<label>Choice <select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
<label>Notes <textarea id="notes"></textarea></label>
<button id="go" onclick="document.getElementById('out').textContent='clicked'">Go</button>
<div id="out"></div>
<button id="nav" onclick="location.href='/result'">Navigate</button>
<script>console.log("hello from page"); fetch("/api").then((r) => r.text());</script>
</body></html>`;

const ARTICLE = `<!doctype html><html><head><title>Article</title></head><body>
<article><h1>A Useful Article</h1>
<p>This article contains enough text for readability to treat it as the main content of the page.</p>
<p>It has a second paragraph with additional detail and a <a href="/result">result link</a>.</p>
</article></body></html>`;

const RESULT = `<!doctype html><html><head><title>Result</title></head><body><h1>Arrived</h1></body></html>`;

const CHALLENGE = `<!doctype html><html><head><title>Just a moment...</title></head><body>
<div id="challenge-form">Checking your browser before accessing the site.</div>
<script>
  setTimeout(() => {
    document.getElementById("challenge-form")?.remove();
    document.title = "Cleared";
  }, 1200);
</script>
</body></html>`;

describe("browser-pilot live", () => {
  let server: TestServer;
  let agentDir: string;
  let cwd: string;
  let sessionId: string;

  beforeAll(async () => {
    server = await startServer((req, res) => {
      const path = req.url ?? "/";
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (path === "/api") {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end('{"ok":true}');
      } else if (path === "/article") res.end(ARTICLE);
      else if (path === "/result") res.end(RESULT);
      else if (path === "/challenge") res.end(CHALLENGE);
      else res.end(PAGE);
    });
    agentDir = mkdtempSync(join(tmpdir(), "browser-pilot-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "browser-pilot-cwd-"));
    sessionId = `live-${Date.now()}`;
    mkdirSync(join(agentDir, "browser-pilot"), { recursive: true });
    writeFileSync(
      join(agentDir, "browser-pilot.json"),
      JSON.stringify({
        profile: "session",
        headless: true,
        closeOnExit: true,
        allowPrivateHosts: true,
        maxTabs: 3,
        screenshotsDir: join(agentDir, "browser-pilot", "screenshots"),
      }),
    );
  });

  afterAll(async () => {
    await disposeAllSessions(true);
    await server.close();
  });

  function ctx(): BrowserPilotContext {
    return {
      cwd,
      agentDir,
      trusted: true,
      sessionId,
    };
  }

  async function run(params: BrowserPilotParams): Promise<BrowserPilotToolResult> {
    return executeBrowserPilot(params, ctx());
  }

  function text(result: BrowserPilotToolResult): string {
    return result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }

  function refFor(snapshot: string, pattern: RegExp): string {
    const match = pattern.exec(snapshot);
    if (!match) throw new Error(`No ref matched ${pattern} in:\n${snapshot}`);
    return match[1];
  }

  it("opens, snapshots, clicks, types, selects, reads, evaluates, screenshots, and closes", async () => {
    const opened = await run({ action: "open", url: `${server.origin}/` });
    expect(opened.isError).toBeUndefined();
    expect(text(opened)).toContain("Pilot Test");

    await run({ action: "wait", for: "network_idle", timeout_ms: 5_000 });
    const consoleLogs = await run({ action: "console", op: "read" });
    expect(text(consoleLogs)).toContain("hello from page");
    const network = await run({ action: "network", op: "read", filter: "/api" });
    expect(text(network)).toContain("/api");

    const snapshot = text(await run({ action: "snapshot" }));
    expect(snapshot).toContain('button "Go"');
    const goRef = refFor(snapshot, /\[(e\d+)\] button "Go"/);
    const nameRef = refFor(snapshot, /\[(e\d+)\] textbox "Name"/);
    const choiceRef = refFor(snapshot, /\[(e\d+)\] combobox "Choice"/);

    const clicked = await run({ action: "click", ref: goRef });
    expect(clicked.isError).toBeUndefined();
    const clickedValue = await run({
      action: "eval",
      expression: "document.getElementById('out').textContent",
    });
    expect(text(clickedValue)).toContain("clicked");

    const typed = await run({ action: "type", ref: nameRef, text: "Ada" });
    expect(typed.isError).toBeUndefined();
    const nameValue = await run({
      action: "eval",
      expression: "document.getElementById('name').value",
    });
    expect(text(nameValue)).toContain("Ada");

    const selected = await run({ action: "select", ref: choiceRef, values: ["b"] });
    expect(selected.isError).toBeUndefined();
    const choiceValue = await run({
      action: "eval",
      expression: "document.getElementById('choice').value",
    });
    expect(text(choiceValue)).toContain("b");

    const article = await run({ action: "navigate", url: `${server.origin}/article` });
    expect(article.isError).toBeUndefined();
    const read = await run({ action: "read", format: "markdown" });
    expect(text(read)).toContain("A Useful Article");
    expect(text(read)).toContain("main content");

    const savedPath = join(agentDir, "article.md");
    const savedRead = await run({ action: "read", save_path: savedPath });
    expect(savedRead.isError).toBeUndefined();
    expect(existsSync(savedPath)).toBe(true);

    const scriptPath = join(agentDir, "title.js");
    writeFileSync(scriptPath, "document.title");
    const scriptEval = await run({ action: "eval", script_path: scriptPath });
    expect(text(scriptEval)).toContain("Article");

    const objectEval = await run({ action: "eval", expression: "({a: 1, b: [2, 3]})" });
    expect(text(objectEval)).toContain('"a": 1');
    expect(text(objectEval)).toContain('"b"');

    await run({ action: "navigate", url: `${server.origin}/` });
    const snapshot2 = text(await run({ action: "snapshot" }));
    const nameRef2 = refFor(snapshot2, /\[(e\d+)\] textbox "Name"/);
    const nameFile = join(agentDir, "name.txt");
    writeFileSync(nameFile, "Grace");
    await run({ action: "type", ref: nameRef2, text_file: nameFile });
    const fileValue = await run({
      action: "eval",
      expression: "document.getElementById('name').value",
    });
    expect(text(fileValue)).toContain("Grace");

    process.env.BROWSER_PILOT_TEST_TEXT = "Katherine";
    try {
      await run({ action: "type", ref: nameRef2, text_env: "BROWSER_PILOT_TEST_TEXT" });
      const envValue = await run({
        action: "eval",
        expression: "document.getElementById('name').value",
      });
      expect(text(envValue)).toContain("Katherine");
    } finally {
      delete process.env.BROWSER_PILOT_TEST_TEXT;
    }

    await run({ action: "scroll", direction: "bottom" });
    const shotPath = join(agentDir, "shot.png");
    const shot = await run({ action: "screenshot", path: shotPath });
    expect(shot.isError).toBeUndefined();
    expect(existsSync(shotPath)).toBe(true);

    const tabs = await run({ action: "tabs", op: "list" });
    expect(text(tabs)).toContain("Tabs: 1/3");

    const closed = await run({ action: "close", target: "browser" });
    expect(closed.isError).toBeUndefined();
  });

  it("detects a challenge and waits for a human to clear it", async () => {
    await run({ action: "open", url: `${server.origin}/challenge` });
    const status = await run({ action: "status" });
    expect(text(status)).toContain("cloudflare");
    expect(text(status)).toContain("blocking");

    const waited = await run({ action: "wait", for: "human", timeout_ms: 10_000 });
    expect(waited.isError, text(waited)).toBeUndefined();
    expect(text(waited)).toContain("Challenge cleared");

    const read = await run({ action: "read", format: "text" });
    expect(text(read)).not.toContain("Checking your browser");
    await run({ action: "close", target: "browser" });
  });
});

describe("browser-pilot profiles and tabs live", () => {
  let server: TestServer;
  let agentDir: string;

  beforeAll(async () => {
    server = await startServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        "<!doctype html><html><head><title>Profile Test</title></head><body><h1>Profile Test</h1></body></html>",
      );
    });
    agentDir = mkdtempSync(join(tmpdir(), "browser-pilot-profile-"));
    writeFileSync(
      join(agentDir, "browser-pilot.json"),
      JSON.stringify({
        profile: "shared",
        headless: true,
        closeOnExit: true,
        allowPrivateHosts: true,
        maxTabs: 1,
      }),
    );
  });

  afterAll(async () => {
    await disposeAllSessions(true);
    await server.close();
  });

  function ctx(sessionId: string): BrowserPilotContext {
    return { cwd: tempCwd(), agentDir, trusted: true, sessionId };
  }

  function tempCwd(): string {
    const dir = mkdtempSync(join(tmpdir(), "browser-pilot-profile-cwd-"));
    return dir;
  }

  it("fails a second session on the shared profile, then succeeds after close", async () => {
    const first = await executeBrowserPilot(
      { action: "open", url: `${server.origin}/` },
      ctx("profile-a"),
    );
    expect(first.isError).toBeUndefined();

    const second = await executeBrowserPilot({ action: "open" }, ctx("profile-b"));
    expect(second.isError).toBe(true);
    expect(
      second.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    ).toContain("already in use");

    const closed = await executeBrowserPilot(
      { action: "close", target: "browser" },
      ctx("profile-a"),
    );
    expect(closed.isError).toBeUndefined();

    const retry = await executeBrowserPilot({ action: "open" }, ctx("profile-b"));
    expect(retry.isError).toBeUndefined();
    await executeBrowserPilot({ action: "close", target: "browser" }, ctx("profile-b"));
  });

  it("recovers from a stale instance record after a crash", async () => {
    const id = "stale";
    const first = await executeBrowserPilot({ action: "open", url: `${server.origin}/` }, ctx(id));
    expect(first.isError).toBeUndefined();
    const status = await executeBrowserPilot({ action: "status" }, ctx(id));
    expect(status.details.pid).toBeTypeOf("number");

    // Kill the process without removing the instance record, as a crash would.
    disposeAllSessionsSync(true);

    const second = await executeBrowserPilot({ action: "open" }, ctx(id));
    expect(second.isError).toBeUndefined();
    await executeBrowserPilot({ action: "close", target: "browser" }, ctx(id));
  });

  it("nudges when the tab limit is reached", async () => {
    const id = "tabs-limit";
    const opened = await executeBrowserPilot({ action: "open", url: `${server.origin}/` }, ctx(id));
    expect(opened.isError).toBeUndefined();
    const second = await executeBrowserPilot(
      { action: "tabs", op: "new", url: `${server.origin}/` },
      ctx(id),
    );
    expect(second.isError).toBe(true);
    expect(
      second.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    ).toContain("Tab limit reached");
    await executeBrowserPilot({ action: "close", target: "browser" }, ctx(id));
  });
});
