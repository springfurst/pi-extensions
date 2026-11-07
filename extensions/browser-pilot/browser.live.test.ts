import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

const SHADOW = `<!doctype html><html><head><title>Shadow Test</title></head><body>
<div id="host"></div>
<iframe id="frame" src="/frame"></iframe>
<script>
  const root = document.getElementById("host").attachShadow({ mode: "open" });
  root.innerHTML = '<button id="shadow-button">Shadow Button</button><div id="shadow-out"></div>';
  root.querySelector('#shadow-button').addEventListener('click', () => { root.querySelector('#shadow-button').textContent = 'shadow clicked'; });
</script>
</body></html>`;

const FRAME = `<!doctype html><html><head><title>Frame Test</title></head><body>
<button id="frame-button" onclick="document.getElementById('frame-out').textContent='frame clicked'">Frame Button</button>
<div id="frame-out"></div>
</body></html>`;

const UPLOAD = `<!doctype html><html><head><title>Upload Test</title></head><body>
<label>File <input id="file" type="file"></label>
</body></html>`;

const DOWNLOAD = `<!doctype html><html><head><title>Download Test</title></head><body>
<a id="download" href="/download" download="sample.txt">Download sample</a>
</body></html>`;

const EMULATE = `<!doctype html><html><head><title>Emulate Test</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<h1>Emulate Test</h1>
<div id="out"></div>
<script>
  document.getElementById("out").textContent = String(window.innerWidth) + ":" + String(matchMedia("(prefers-color-scheme: dark)").matches);
</script>
</body></html>`;

const ROUTE = `<!doctype html><html><head><title>Route Test</title></head><body>
<h1>Route Test</h1><div id="out"></div>
<script>
  fetch("/mocked").then((r) => r.text()).then((text) => { document.getElementById("out").textContent = text; });
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
      else if (path === "/shadow") res.end(SHADOW);
      else if (path === "/frame") res.end(FRAME);
      else if (path === "/upload") res.end(UPLOAD);
      else if (path === "/download-page") res.end(DOWNLOAD);
      else if (path === "/emulate") res.end(EMULATE);
      else if (path === "/route-page") res.end(ROUTE);
      else if (path === "/download") {
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.setHeader("content-disposition", 'attachment; filename="sample.txt"');
        res.end("sample download");
      } else res.end(PAGE);
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

  it("supports shadow and iframe refs, upload, download, cookies, storage, emulation, routing, expectations, batches, and exports", async () => {
    await run({ action: "open", url: `${server.origin}/shadow` });
    const shadowSnapshot = text(await run({ action: "snapshot" }));
    expect(shadowSnapshot).toContain("Shadow Button");
    expect(shadowSnapshot).toContain("Frame Button");
    const shadowRef = refFor(shadowSnapshot, /\[(e\d+)\] button "Shadow Button"/);
    const frameRef = refFor(shadowSnapshot, /\[(e\d+)\] button "Frame Button"/);
    await run({ action: "click", ref: shadowRef });
    await run({ action: "click", ref: frameRef });
    const shadowClicked = await run({
      action: "eval",
      expression:
        "document.getElementById('host').shadowRoot.querySelector('#shadow-button').textContent",
    });
    expect(text(shadowClicked)).toContain("shadow clicked");
    const frameClicked = await run({
      action: "eval",
      expression:
        "document.querySelector('iframe').contentDocument.getElementById('frame-out').textContent",
    });
    expect(text(frameClicked)).toContain("frame clicked");

    await run({ action: "navigate", url: `${server.origin}/upload` });
    const uploadSnapshot = text(await run({ action: "snapshot" }));
    const fileRef = refFor(uploadSnapshot, /\[(e\d+)\] file "File"/);
    const uploadPath = join(cwd, "upload.txt");
    writeFileSync(uploadPath, "uploaded");
    const uploaded = await run({ action: "upload", ref: fileRef, files: [uploadPath] });
    expect(uploaded.isError, text(uploaded)).toBeUndefined();
    const uploadedName = await run({
      action: "eval",
      expression: "document.getElementById('file').files[0].name",
    });
    expect(text(uploadedName)).toContain("upload.txt");

    await run({ action: "navigate", url: `${server.origin}/download-page` });
    const downloadSnapshot = text(await run({ action: "snapshot" }));
    const downloadRef = refFor(downloadSnapshot, /\[(e\d+)\] link "Download sample"/);
    await run({ action: "click", ref: downloadRef });
    const downloaded = await run({ action: "download", op: "wait", timeout_ms: 10_000 });
    expect(downloaded.isError, text(downloaded)).toBeUndefined();
    expect(text(downloaded)).toContain("sample.txt");

    await run({ action: "navigate", url: `${server.origin}/` });
    const setCookie = await run({
      action: "cookies",
      op: "set",
      name: "pilot",
      value: "yes",
      url: server.origin,
    });
    expect(setCookie.isError, text(setCookie)).toBeUndefined();
    const cookies = await run({ action: "cookies", op: "list" });
    expect(text(cookies)).toContain("pilot=yes");
    const storageSet = await run({ action: "storage", op: "set", key: "theme", value: "dark" });
    expect(storageSet.isError).toBeUndefined();
    const storageGet = await run({ action: "storage", op: "get", key: "theme" });
    expect(text(storageGet)).toContain("dark");
    await run({ action: "storage", op: "remove", key: "theme" });
    await run({ action: "cookies", op: "clear" });

    await run({ action: "navigate", url: `${server.origin}/emulate` });
    const emulated = await run({
      action: "emulate",
      width: 390,
      height: 844,
      is_mobile: true,
      has_touch: true,
      color_scheme: "dark",
      cpu_throttle: 2,
    });
    expect(emulated.isError, text(emulated)).toBeUndefined();
    const emulatedValue = await run({
      action: "eval",
      expression: "document.getElementById('out').textContent",
    });
    expect(text(emulatedValue)).toContain("390:true");
    const reset = await run({ action: "emulate", reset: true });
    expect(reset.isError, text(reset)).toBeUndefined();

    const route = await run({
      action: "route",
      op: "add",
      url_pattern: `${server.origin}/mocked`,
      route_action: "fulfill",
      status: 200,
      body: '{"mocked":true}',
      content_type: "application/json",
    });
    expect(route.isError, text(route)).toBeUndefined();
    await run({ action: "navigate", url: `${server.origin}/route-page` });
    await run({ action: "expect", check: "text", expected: "mocked", timeout_ms: 5_000 });
    const routeList = await run({ action: "route", op: "list" });
    expect(text(routeList)).toContain("fulfill");
    await run({ action: "route", op: "clear" });

    const expectedTitle = await run({ action: "expect", check: "title", expected: "Route Test" });
    expect(expectedTitle.isError).toBeUndefined();
    const expectedCount = await run({
      action: "expect",
      check: "count",
      selector: "h1",
      expected: "1",
    });
    expect(expectedCount.isError).toBeUndefined();

    const steps = await run({
      action: "steps",
      steps: [
        { action: "navigate", url: `${server.origin}/result` },
        { action: "expect", check: "title", expected: "Result" },
      ],
    });
    expect(steps.isError, text(steps)).toBeUndefined();
    expect(text(steps)).toContain("Step 2: expect");

    const harPath = join(cwd, "network.har");
    await run({ action: "har", op: "start" });
    await run({ action: "navigate", url: `${server.origin}/` });
    const har = await run({ action: "har", op: "stop", path: harPath });
    expect(har.isError, text(har)).toBeUndefined();
    expect(existsSync(harPath)).toBe(true);
    const harJson = JSON.parse(readFileSync(harPath, "utf-8")) as {
      log: { version: string; entries: unknown[] };
    };
    expect(harJson.log.version).toBe("1.2");
    expect(harJson.log.entries.length).toBeGreaterThan(0);

    const tracePath = join(cwd, "trace.json");
    await run({ action: "trace", op: "start" });
    await run({ action: "eval", expression: "1 + 1" });
    const trace = await run({ action: "trace", op: "stop", path: tracePath });
    expect(trace.isError, text(trace)).toBeUndefined();
    expect(existsSync(tracePath)).toBe(true);
    const traceJson = JSON.parse(readFileSync(tracePath, "utf-8")) as {
      traceEvents: unknown[];
    };
    expect(traceJson.traceEvents.length).toBeGreaterThan(0);

    const pdfPath = join(cwd, "page.pdf");
    const pdf = await run({ action: "pdf", path: pdfPath });
    expect(pdf.isError, text(pdf)).toBeUndefined();
    expect(existsSync(pdfPath)).toBe(true);
    expect(statSync(pdfPath).size).toBeGreaterThan(0);

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

  it("attaches to an existing DevTools endpoint and disconnects without closing it", async () => {
    const idA = "external-a";
    const idB = "external-b";
    const opened = await executeBrowserPilot(
      { action: "open", url: `${server.origin}/` },
      ctx(idA),
    );
    expect(opened.isError).toBeUndefined();
    const statusA = await executeBrowserPilot({ action: "status" }, ctx(idA));
    const port = statusA.details.port as number;
    expect(port).toBeGreaterThan(0);

    const attached = await executeBrowserPilot(
      { action: "connect", endpoint: `http://127.0.0.1:${port}` },
      ctx(idB),
    );
    expect(attached.isError).toBeUndefined();
    const tabs = await executeBrowserPilot({ action: "tabs", op: "list" }, ctx(idB));
    expect(tabs.isError).toBeUndefined();

    await executeBrowserPilot({ action: "close", target: "browser" }, ctx(idB));
    const statusA2 = await executeBrowserPilot({ action: "status" }, ctx(idA));
    expect(
      statusA2.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    ).toContain("Browser: running");
    await executeBrowserPilot({ action: "close", target: "browser" }, ctx(idA));
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
