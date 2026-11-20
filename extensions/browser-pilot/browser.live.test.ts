import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "../../lib/web/__fixtures__/server";
import { disposeAllSessions, disposeAllSessionsSync } from "./session";
import { executeBrowserPilot, type BrowserPilotToolResult } from "./tool";
import type { BrowserPilotCall, BrowserPilotContext, BrowserPilotParams } from "./types";

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

const HIDDEN = `<!doctype html><html><head><title>Hidden Test</title></head><body>
<div id="hidden" style="display:none">Hidden text</div>
<button id="show" onclick="document.getElementById('hidden').style.display='block'">Show</button>
</body></html>`;

const POPUP = `<!doctype html><html><head><title>Popup Test</title></head><body>
<button id="popup" onclick="window.open('/result','_blank','noopener')">Open</button>
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
      else if (path === "/hidden") res.end(HIDDEN);
      else if (path === "/popup-page") res.end(POPUP);
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
        allowLocalFiles: true,
        localFileGlobs: ["fixtures/**"],
        maxTabs: 3,
        tabOverflow: "reuse-blank",
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

  async function run(
    input: BrowserPilotParams | BrowserPilotCall,
  ): Promise<BrowserPilotToolResult> {
    if ("params" in input && input.params !== undefined) {
      return executeBrowserPilot(input as BrowserPilotCall, ctx());
    }
    const { action, ...rest } = input as BrowserPilotParams;
    return executeBrowserPilot({ action, params: rest }, ctx());
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
    const opened = await run({ action: "open", params: { url: `${server.origin}/` } });
    expect(opened.isError).toBeUndefined();
    expect(text(opened)).toContain("Pilot Test");

    await run({ action: "wait", until: "network_idle", timeout_ms: 5_000 });
    const consoleLogs = await run({ action: "console", operation: "read" });
    expect(text(consoleLogs)).toContain("hello from page");
    const network = await run({ action: "network", operation: "read", filter: "/api" });
    expect(text(network)).toContain("/api");

    const snapshot = text(await run({ action: "snapshot" }));
    expect(snapshot).toContain('button "Go"');
    const goRef = refFor(snapshot, /\[(e\d+)\] button "Go"/);
    const nameRef = refFor(snapshot, /\[(e\d+)\] textbox "Name"/);
    const choiceRef = refFor(snapshot, /\[(e\d+)\] combobox "Choice"/);

    const clicked = await run({ action: "click", ref: goRef });
    expect(clicked.isError).toBeUndefined();
    expect(clicked.details.subject).toBe('button "Go"');
    const clickedValue = await run({
      action: "eval",
      expression: "document.getElementById('out').textContent",
    });
    expect(text(clickedValue)).toContain("clicked");

    const typed = await run({ action: "type", ref: nameRef, text: "Ada" });
    expect(typed.isError).toBeUndefined();
    expect(typed.details.subject).toBe('textbox "Name"');
    expect(typed.details.preview).toBe("Ada");
    const nameValue = await run({
      action: "eval",
      expression: "document.getElementById('name').value",
    });
    expect(text(nameValue)).toContain("Ada");

    const selectAll = process.platform === "darwin" ? "Meta+A" : "Control+A";
    const pressed = await run({ action: "press", ref: nameRef, key: selectAll });
    expect(pressed.isError).toBeUndefined();
    const selection = await run({
      action: "eval",
      expression:
        "(() => { const el = document.getElementById('name'); return `${el.selectionStart}:${el.selectionEnd}`; })()",
    });
    expect(text(selection)).toContain("0:3");

    const unknownKey = await run({ action: "press", key: "Hyper+A" });
    expect(unknownKey.isError).toBe(true);
    expect(text(unknownKey)).toContain("Unknown modifier");

    const selected = await run({ action: "select", ref: choiceRef, values: ["b"] });
    expect(selected.isError).toBeUndefined();
    const choiceValue = await run({
      action: "eval",
      expression: "document.getElementById('choice').value",
    });
    expect(text(choiceValue)).toContain("b");

    const selectedByLabel = await run({ action: "select", ref: choiceRef, values: ["Alpha"] });
    expect(selectedByLabel.isError).toBeUndefined();
    expect(text(selectedByLabel)).toContain("Selected: a");
    const labelValue = await run({
      action: "eval",
      expression: "document.getElementById('choice').value",
    });
    expect(text(labelValue)).toContain("a");

    const unknownOption = await run({ action: "select", ref: choiceRef, values: ["Delta"] });
    expect(unknownOption.isError).toBe(true);
    expect(text(unknownOption)).toContain("Available:");

    const article = await run({ action: "navigate", url: `${server.origin}/article` });
    expect(article.isError).toBeUndefined();
    const read = await run({ action: "read", format: "markdown" });
    expect(text(read)).toContain("A Useful Article");
    expect(text(read)).toContain("main content");
    expect(read.details.preview).toContain("A Useful Article");

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
    expect(objectEval.details.preview).toBe("({a: 1, b: [2, 3]})");

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

    const tabs = await run({ action: "tabs", params: { operation: "list" } });
    expect(text(tabs)).toContain("Tabs: 1/3");

    const closed = await run({ action: "close", params: { target: "browser" } });
    expect(closed.isError).toBeUndefined();
  });

  it("detects a challenge and waits for a human to clear it", async () => {
    await run({ action: "open", url: `${server.origin}/challenge` });
    const status = await run({ action: "status" });
    expect(text(status)).toContain("cloudflare");
    expect(text(status)).toContain("blocking");

    const waited = await run({ action: "wait", until: "human", timeout_ms: 10_000 });
    expect(waited.isError, text(waited)).toBeUndefined();
    expect(text(waited)).toContain("Challenge cleared");

    const read = await run({ action: "read", format: "text" });
    expect(text(read)).not.toContain("Checking your browser");
    await run({ action: "close", params: { target: "browser" } });
  });

  it("handles hidden assertions, blank-tab reuse, and noopener popups", async () => {
    await run({ action: "open", url: `${server.origin}/hidden` });
    const hidden = await run({
      action: "expect",
      check: "hidden",
      selector: "#hidden",
      timeout_ms: 2_000,
    });
    expect(hidden.isError, text(hidden)).toBeUndefined();
    const absent = await run({
      action: "expect",
      check: "hidden",
      selector: "#missing",
      timeout_ms: 2_000,
    });
    expect(absent.isError, text(absent)).toBeUndefined();
    const visible = await run({
      action: "expect",
      check: "visible",
      selector: "#show",
      timeout_ms: 2_000,
    });
    expect(visible.isError, text(visible)).toBeUndefined();

    await run({ action: "tabs", operation: "new" });
    await run({ action: "tabs", operation: "new", url: `${server.origin}/result` });
    const reused = await run({ action: "tabs", operation: "new", url: `${server.origin}/article` });
    expect(reused.isError, text(reused)).toBeUndefined();
    expect(text(reused)).toContain("Article");
    await run({ action: "tabs", operation: "close", tab: 3 });

    await run({ action: "navigate", url: `${server.origin}/popup-page` });
    const snapshot = text(await run({ action: "snapshot" }));
    const popupRef = refFor(snapshot, /\[(e\d+)\] button "Open"/);
    await run({ action: "click", ref: popupRef });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const tabs = text(await run({ action: "tabs", params: { operation: "list" } }));
    expect(tabs).toContain("/result");
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
    const downloaded = await run({ action: "download", operation: "wait", timeout_ms: 10_000 });
    expect(downloaded.isError, text(downloaded)).toBeUndefined();
    expect(text(downloaded)).toContain("sample.txt");

    await run({ action: "navigate", url: `${server.origin}/` });
    const setCookie = await run({
      action: "cookies",
      operation: "set",
      name: "pilot",
      value: "yes",
      url: server.origin,
    });
    expect(setCookie.isError, text(setCookie)).toBeUndefined();
    const cookies = await run({ action: "cookies", operation: "list" });
    expect(text(cookies)).toContain("pilot=yes");
    const storageSet = await run({
      action: "storage",
      operation: "set",
      key: "theme",
      value: "dark",
    });
    expect(storageSet.isError).toBeUndefined();
    const storageGet = await run({ action: "storage", operation: "get", key: "theme" });
    expect(text(storageGet)).toContain("dark");
    await run({ action: "storage", operation: "remove", key: "theme" });
    await run({ action: "cookies", operation: "clear" });

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
      operation: "add",
      url_pattern: `${server.origin}/mocked`,
      route_action: "fulfill",
      response_status: 200,
      response_body: '{"mocked":true}',
      response_content_type: "application/json",
    });
    expect(route.isError, text(route)).toBeUndefined();
    await run({ action: "navigate", url: `${server.origin}/route-page` });
    await run({ action: "expect", check: "text", expected: "mocked", timeout_ms: 5_000 });
    const routeList = await run({ action: "route", operation: "list" });
    expect(text(routeList)).toContain("fulfill");
    await run({ action: "route", operation: "clear" });

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
        { action: "navigate", params: { url: `${server.origin}/result` } },
        { action: "expect", params: { check: "title", expected: "Result" } },
      ],
    });
    expect(steps.isError, text(steps)).toBeUndefined();
    expect(text(steps)).toContain("Step 2: expect");

    const harPath = join(cwd, "network.har");
    await run({ action: "har", operation: "start" });
    await run({ action: "navigate", url: `${server.origin}/` });
    const har = await run({ action: "har", operation: "stop", path: harPath });
    expect(har.isError, text(har)).toBeUndefined();
    expect(existsSync(harPath)).toBe(true);
    const harJson = JSON.parse(readFileSync(harPath, "utf-8")) as {
      log: { version: string; entries: unknown[] };
    };
    expect(harJson.log.version).toBe("1.2");
    expect(harJson.log.entries.length).toBeGreaterThan(0);

    const tracePath = join(cwd, "trace.json");
    await run({ action: "trace", operation: "start" });
    await run({ action: "eval", expression: "1 + 1" });
    const trace = await run({ action: "trace", operation: "stop", path: tracePath });
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

    await run({ action: "close", params: { target: "browser" } });
  });

  it("supports selector snapshots, ref reads, frames, network ids, doctor, metrics, state, and annotations", async () => {
    await run({ action: "open", url: `${server.origin}/shadow` });

    const doctor = await run({ action: "doctor" });
    expect(doctor.isError, text(doctor)).toBeUndefined();
    expect(text(doctor)).toContain("browser binary");
    expect(text(doctor)).toContain("profile");

    const scoped = text(await run({ action: "snapshot", selector: "#host" }));
    expect(scoped).toContain("Shadow Button");
    expect(scoped).not.toContain("Frame Button");
    const shadowRef = refFor(scoped, /\[(e\d+)\] button "Shadow Button"/);

    const readRef = await run({ action: "read", ref: shadowRef, format: "text" });
    expect(readRef.isError, text(readRef)).toBeUndefined();
    expect(text(readRef)).toContain("Shadow Button");

    const outline = await run({ action: "read", format: "outline" });
    expect(outline.isError, text(outline)).toBeUndefined();
    expect(text(outline)).toContain("Shadow Button");

    const refShot = join(agentDir, "ref-shot.png");
    const refScreenshot = await run({ action: "screenshot", ref: shadowRef, path: refShot });
    expect(refScreenshot.isError, text(refScreenshot)).toBeUndefined();
    expect(existsSync(refShot)).toBe(true);

    const annotatedPath = join(agentDir, "annotated.png");
    const annotated = await run({
      action: "screenshot",
      path: annotatedPath,
      annotate: true,
    });
    expect(annotated.isError, text(annotated)).toBeUndefined();
    expect(annotated.details.annotated).toBeGreaterThan(0);

    const frames = await run({ action: "frames", operation: "list" });
    expect(text(frames)).toContain("/frame");
    const frameList = frames.details.frames as Array<{ index: number; url: string }>;
    const frameIndex = frameList.find((frame) => frame.url.endsWith("/frame"))?.index;
    expect(frameIndex).toBeGreaterThan(0);

    await run({ action: "frames", operation: "select", frame: frameIndex });
    const frameRead = await run({ action: "read", format: "text" });
    expect(text(frameRead)).toContain("Frame Button");
    const frameEval = await run({ action: "eval", expression: "document.title" });
    expect(text(frameEval)).toContain("Frame Test");
    await run({ action: "frames", operation: "main" });

    await run({ action: "navigate", url: `${server.origin}/` });
    await run({ action: "wait", until: "network_idle", timeout_ms: 5_000 });
    const overview = await run({ action: "network", operation: "read", filter: "/api" });
    const overviewText = text(overview);
    expect(overviewText).toMatch(/r\d+ 200 GET \/api/);
    const requestId = /r\d+/.exec(overviewText)?.[0];
    expect(requestId).toBeTruthy();

    const detail = await run({ action: "network", operation: "get", request_id: requestId });
    expect(detail.isError, text(detail)).toBeUndefined();
    expect(text(detail)).toContain("Response headers:");
    expect(text(detail)).toContain('{"ok":true}');

    const responseWait = await run({
      action: "wait",
      until: "response",
      url_pattern: "/api",
      include_body: true,
      timeout_ms: 5_000,
    });
    expect(responseWait.isError, text(responseWait)).toBeUndefined();
    expect(text(responseWait)).toMatch(/Response r\d+/);
    expect(text(responseWait)).toContain('{"ok":true}');

    const metrics = await run({ action: "metrics" });
    expect(metrics.isError, text(metrics)).toBeUndefined();
    expect(text(metrics)).toContain("Heap:");
    expect(text(metrics)).toContain("DOM:");

    const snapshot = text(await run({ action: "snapshot" }));
    const goRef = refFor(snapshot, /\[(e\d+)\] button "Go"/);
    const highlight = await run({ action: "highlight", ref: goRef, duration_ms: 500 });
    expect(highlight.isError, text(highlight)).toBeUndefined();
    expect(text(highlight)).toContain("Highlighted");

    await run({
      action: "cookies",
      operation: "set",
      name: "pilot_state",
      value: "yes",
      url: server.origin,
    });
    await run({ action: "storage", operation: "set", key: "theme", value: "dark" });
    const bundlePath = join(cwd, "state.json");
    const exported = await run({ action: "state", operation: "export", path: bundlePath });
    expect(exported.isError, text(exported)).toBeUndefined();
    expect(existsSync(bundlePath)).toBe(true);
    await run({ action: "cookies", operation: "clear" });
    await run({ action: "storage", operation: "clear" });
    const imported = await run({ action: "state", operation: "import", path: bundlePath });
    expect(imported.isError, text(imported)).toBeUndefined();
    const importedCookies = await run({ action: "cookies", operation: "list" });
    expect(text(importedCookies)).toContain("pilot_state=yes");
    const importedStorage = await run({ action: "storage", operation: "get", key: "theme" });
    expect(text(importedStorage)).toContain("dark");

    const permissions = await run({
      action: "emulate",
      permissions: ["geolocation"],
      origin: server.origin,
    });
    expect(permissions.isError, text(permissions)).toBeUndefined();
    expect(text(permissions)).toContain("permissions");
    await run({ action: "emulate", reset: true });

    const clipboardWrite = await run({
      action: "clipboard",
      operation: "write",
      text: "pilot-clipboard",
    });
    expect(clipboardWrite.isError, text(clipboardWrite)).toBeUndefined();
    const clipboardRead = await run({ action: "clipboard", operation: "read" });
    expect(clipboardRead.isError, text(clipboardRead)).toBeUndefined();
    expect(text(clipboardRead)).toContain("pilot-clipboard");

    await run({ action: "close", params: { target: "browser" } });
  });

  it("opens local files that match the configured globs", async () => {
    const fixtures = join(cwd, "fixtures");
    mkdirSync(fixtures, { recursive: true });
    const page = join(fixtures, "local.html");
    writeFileSync(
      page,
      "<!doctype html><html><head><title>Local Fixture</title></head><body><h1>Local Fixture</h1><p>A page on disk.</p></body></html>",
    );

    const relative = await run({ action: "open", url: "./fixtures/local.html" });
    expect(relative.isError, text(relative)).toBeUndefined();
    expect(text(relative)).toContain("Local Fixture");
    expect(relative.details.url).toContain("file://");
    expect(text(await run({ action: "read" }))).toContain("A page on disk");

    const byUrl = await run({ action: "navigate", url: pathToFileURL(page).href });
    expect(byUrl.isError, text(byUrl)).toBeUndefined();

    const outside = join(cwd, "outside.html");
    writeFileSync(outside, "<!doctype html><title>Outside</title>");
    const blocked = await run({ action: "navigate", url: outside });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain("does not match localFileGlobs");

    await run({ action: "close", params: { target: "browser" } });
  });

  it("follows same-document history without claiming the entry is missing", async () => {
    await run({ action: "open", params: { url: `${server.origin}/` } });
    await run({ action: "eval", expression: "history.pushState({}, '', '/same-document')" });

    const back = await run({ action: "navigate", direction: "back" });
    expect(back.isError, text(back)).toBeUndefined();
    expect(text(back)).not.toContain("No earlier history entry");
    const path = await run({ action: "eval", expression: "location.pathname" });
    expect(text(path)).toContain("/");

    const forward = await run({ action: "navigate", direction: "forward" });
    expect(forward.isError, text(forward)).toBeUndefined();
    expect(text(forward)).not.toContain("No later history entry");
    const forwardPath = await run({ action: "eval", expression: "location.pathname" });
    expect(text(forwardPath)).toContain("/same-document");

    await run({ action: "close", params: { target: "browser" } });
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

  it("shares one browser between sessions and keeps their tabs apart", async () => {
    const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
      result.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");

    const first = await executeBrowserPilot(
      { action: "open", params: { url: `${server.origin}/first` } },
      ctx("profile-a"),
    );
    expect(first.isError).toBeUndefined();

    const second = await executeBrowserPilot(
      { action: "open", params: { url: `${server.origin}/second` } },
      ctx("profile-b"),
    );
    expect(second.isError).toBeUndefined();

    const tabsA = await executeBrowserPilot(
      { action: "tabs", params: { operation: "list" } },
      ctx("profile-a"),
    );
    const tabsB = await executeBrowserPilot(
      { action: "tabs", params: { operation: "list" } },
      ctx("profile-b"),
    );
    expect(text(tabsA)).toContain("/first");
    expect(text(tabsA)).not.toContain("/second");
    expect(text(tabsB)).toContain("/second");
    expect(text(tabsB)).not.toContain("/first");

    const closedA = await executeBrowserPilot(
      { action: "close", params: { target: "browser" } },
      ctx("profile-a"),
    );
    expect(closedA.isError).toBeUndefined();
    expect(text(closedA)).toContain("stays open");

    const stillB = await executeBrowserPilot(
      { action: "tabs", params: { operation: "list" } },
      ctx("profile-b"),
    );
    expect(stillB.isError).toBeUndefined();
    expect(text(stillB)).toContain("/second");

    const closedB = await executeBrowserPilot(
      { action: "close", params: { target: "browser" } },
      ctx("profile-b"),
    );
    expect(closedB.isError).toBeUndefined();
  });

  it("attaches to an existing DevTools endpoint and disconnects without closing it", async () => {
    const idA = "external-a";
    const idB = "external-b";
    const opened = await executeBrowserPilot(
      { action: "open", params: { url: `${server.origin}/` } },
      ctx(idA),
    );
    expect(opened.isError).toBeUndefined();
    const statusA = await executeBrowserPilot({ action: "status" }, ctx(idA));
    const port = statusA.details.port as number;
    expect(port).toBeGreaterThan(0);

    const attached = await executeBrowserPilot(
      { action: "connect", params: { endpoint: `http://127.0.0.1:${port}` } },
      ctx(idB),
    );
    expect(attached.isError).toBeUndefined();
    const tabs = await executeBrowserPilot(
      { action: "tabs", params: { operation: "list" } },
      ctx(idB),
    );
    expect(tabs.isError).toBeUndefined();

    await executeBrowserPilot({ action: "close", params: { target: "browser" } }, ctx(idB));
    const statusA2 = await executeBrowserPilot({ action: "status" }, ctx(idA));
    expect(
      statusA2.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    ).toContain("Browser: running");
    await executeBrowserPilot({ action: "close", params: { target: "browser" } }, ctx(idA));
  });

  it("recovers from a stale instance record after a crash", async () => {
    const id = "stale";
    const first = await executeBrowserPilot(
      { action: "open", params: { url: `${server.origin}/` } },
      ctx(id),
    );
    expect(first.isError).toBeUndefined();
    const status = await executeBrowserPilot({ action: "status" }, ctx(id));
    expect(status.details.pid).toBeTypeOf("number");

    // Kill the process without removing the instance record, as a crash would.
    disposeAllSessionsSync(true);

    const second = await executeBrowserPilot({ action: "open" }, ctx(id));
    expect(second.isError).toBeUndefined();
    await executeBrowserPilot({ action: "close", params: { target: "browser" } }, ctx(id));
  });

  it("nudges when the tab limit is reached", async () => {
    const id = "tabs-limit";
    const opened = await executeBrowserPilot(
      { action: "open", params: { url: `${server.origin}/` } },
      ctx(id),
    );
    expect(opened.isError).toBeUndefined();
    const second = await executeBrowserPilot(
      { action: "tabs", params: { operation: "new", url: `${server.origin}/` } },
      ctx(id),
    );
    expect(second.isError).toBe(true);
    expect(
      second.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    ).toContain("Tab limit reached");
    await executeBrowserPilot({ action: "close", params: { target: "browser" } }, ctx(id));
  });
});
