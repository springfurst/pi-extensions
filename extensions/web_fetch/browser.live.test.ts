// SPDX-License-Identifier: MIT
// Opt-in live-browser check for the web_fetch browser backend.
// Run with `npm run test:live`; skipped cleanly when no browser resolves.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposeSharedBrowser, resolveBrowserExecutable } from "../../lib/browser";
import { startServer } from "../../lib/web/__fixtures__/server";
import { executeWebFetch } from "./tool";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "webtools-live-browser-"));
  writeFileSync(
    join(dir, "web-tools.json"),
    JSON.stringify({
      fetch: { allowPrivateHosts: true, externalReaders: false, remoteFallbacks: false },
      browser: { allowPrivateHosts: true },
    }),
  );
});

afterAll(async () => {
  await disposeSharedBrowser();
  rmSync(dir, { recursive: true, force: true });
});

const JS_PAGE = `<!doctype html><html><head><title>App</title></head><body>
<div id="root"></div>
<script>
  document.getElementById('root').innerHTML =
    '<article><h1>Live Browser</h1><p>' +
    'A rendered paragraph long enough to clear the Readability quality gate. '.repeat(4) +
    '</p></article>';
</script>
<noscript>Please enable JavaScript to view this page.</noscript>
</body></html>`;

describe("web_fetch live browser backend", () => {
  it("renders a JavaScript-only page through a real browser", async ({ skip }) => {
    const executablePath = await resolveBrowserExecutable();
    if (!executablePath) skip();

    const server = await startServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(JS_PAGE);
    });
    try {
      const result = await executeWebFetch(
        { url: `${server.origin}/app` },
        { cwd: dir, agentDir: dir, trusted: false },
      );
      expect(["readability", "browser"]).toContain(result.details.method);
      expect(result.content[0].text).toContain("Live Browser");
      expect(result.details.notes.join(" ")).toMatch(/needs JavaScript|JavaScript rendering/);
    } finally {
      await server.close();
    }
  });
});
