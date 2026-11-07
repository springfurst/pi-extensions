import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Browser, CDPSession } from "puppeteer-core";
import { safeFilename, sleep } from "./session-helpers";
import type { DownloadInfo } from "./types";
import { BrowserPilotError } from "./types";

/**
 * Resolve the file Chrome actually wrote. Chrome renames collisions, so the
 * suggested filename is only a prediction.
 */
export function resolveDownloadedFile(directory: string, predictedPath: string): string {
  if (existsSync(predictedPath)) return predictedPath;
  try {
    const base = basename(predictedPath);
    const extension = extname(base);
    const stem = extension ? base.slice(0, -extension.length) : base;
    const candidates: Array<{ path: string; mtime: number }> = [];
    for (const name of readdirSync(directory)) {
      if (name !== base && !(name.startsWith(stem) && name.endsWith(extension))) continue;
      const path = join(directory, name);
      try {
        const stat = statSync(path);
        if (stat.isFile()) candidates.push({ path, mtime: stat.mtimeMs });
      } catch {
        // A concurrent delete or rename is not fatal.
      }
    }
    candidates.sort((left, right) => right.mtime - left.mtime);
    return candidates[0]?.path ?? predictedPath;
  } catch {
    return predictedPath;
  }
}

/** Browser-level download capture and history. */
export class DownloadTracker {
  readonly items: DownloadInfo[] = [];
  private client?: CDPSession;
  private directory?: string;

  async configure(browser: Browser, directory: string): Promise<void> {
    if (this.client) return;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.directory = directory;
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
    return this.items
      .filter(
        (download) =>
          !filter || download.suggestedFilename.includes(filter) || download.url.includes(filter),
      )
      .map((download) => this.refreshPath(download));
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

  private refreshPath(download: DownloadInfo): DownloadInfo {
    if (download.state === "completed" && this.directory) {
      download.path = resolveDownloadedFile(this.directory, download.path);
    }
    return download;
  }
}
