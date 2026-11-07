import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, CDPSession } from "puppeteer-core";
import { safeFilename, sleep } from "./session-helpers";
import type { DownloadInfo } from "./types";
import { BrowserPilotError } from "./types";

/** Browser-level download capture and history. */
export class DownloadTracker {
  readonly items: DownloadInfo[] = [];
  private client?: CDPSession;

  async configure(browser: Browser, directory: string): Promise<void> {
    if (this.client) return;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const client = await browser.target().createCDPSession();
      await client.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: directory,
        eventsEnabled: true,
      });
      client.on(
        "Browser.downloadWillBegin",
        (event: { guid?: string; url?: string; suggestedFilename?: string }) => {
          if (!event.guid) return;
          const filename = safeFilename(event.suggestedFilename ?? event.guid);
          this.items.push({
            id: event.guid,
            url: event.url ?? "",
            suggestedFilename: filename,
            state: "inProgress",
            receivedBytes: 0,
            totalBytes: 0,
            path: join(directory, filename),
            startedAt: new Date().toISOString(),
          });
        },
      );
      client.on(
        "Browser.downloadProgress",
        (event: {
          guid?: string;
          state?: "inProgress" | "completed" | "canceled";
          receivedBytes?: number;
          totalBytes?: number;
        }) => {
          const download = this.items.find((item) => item.id === event.guid);
          if (!download) return;
          if (event.state) download.state = event.state;
          if (event.receivedBytes !== undefined) download.receivedBytes = event.receivedBytes;
          if (event.totalBytes !== undefined) download.totalBytes = event.totalBytes;
          if (download.state !== "inProgress" && !download.completedAt) {
            download.completedAt = new Date().toISOString();
          }
        },
      );
      this.client = client;
    } catch {
      // Download capture is optional; the browser may not support the command.
    }
  }

  reset(): void {
    this.client = undefined;
  }

  list(filter?: string): DownloadInfo[] {
    return this.items.filter(
      (download) =>
        !filter || download.suggestedFilename.includes(filter) || download.url.includes(filter),
    );
  }

  async wait(timeoutMs: number, filter?: string, signal?: AbortSignal): Promise<DownloadInfo> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const download = this.list(filter).at(-1);
      if (download && download.state !== "inProgress") return download;
      await sleep(100);
    }
    throw new BrowserPilotError(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for a download.`,
      'Check download {op:"list"}; the browser may have blocked or canceled the file.',
    );
  }

  clear(): number {
    const count = this.items.length;
    this.items.length = 0;
    return count;
  }
}
