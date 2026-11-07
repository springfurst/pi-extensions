import type { CDPSession } from "puppeteer-core";
import { buildHar } from "./har";
import { sleep } from "./session-helpers";
import type { BrowserPilotSession } from "./session";
import type { TabInfo } from "./types";
import { BrowserPilotError } from "./types";

export const MAX_HAR_BODY_BYTES = 1024 * 1024;

export class RecordingController {
  private harRecording = false;
  private traceClient?: CDPSession;
  private traceChunks: string[] = [];
  private traceTab?: number;

  constructor(private readonly session: BrowserPilotSession) {}

  /** Start recording a HAR. Existing network buffers are cleared. */
  startHar(): void {
    this.harRecording = true;
    for (const tab of this.session.tabs.values()) tab.network.length = 0;
    this.session.clearNetworkDetails();
  }

  /** True while HAR capture is active. */
  get isRecordingHar(): boolean {
    return this.harRecording;
  }

  /** Clear captured network entries used by HAR export. */
  clearHar(): number {
    let count = 0;
    for (const tab of this.session.tabs.values()) {
      count += tab.network.length;
      tab.network.length = 0;
    }
    this.session.clearNetworkDetails();
    return count;
  }

  /** Stop recording and return a HAR document built from captured entries. */
  async stopHar(): Promise<{ har: Record<string, unknown>; entries: number }> {
    this.harRecording = false;
    const entries = [...this.session.tabs.values()].flatMap((tab) => tab.network);
    const har = buildHar(entries, { tabs: await this.session.listTabs() });
    return { har, entries: entries.length };
  }

  /** Start a Chrome trace for one tab. */
  async startTrace(tabHandle?: number): Promise<TabInfo> {
    if (this.traceClient) {
      throw new BrowserPilotError(
        "A trace is already recording.",
        'Stop it with {action:"trace", op:"stop"}.',
      );
    }
    const tab = await this.session.ensureTab(tabHandle);
    const client = await tab.page.createCDPSession();
    this.traceChunks = [];
    this.traceTab = tab.handle;
    this.traceClient = client;
    client.on("Tracing.dataCollected", (event: { value?: string[] }) => {
      if (Array.isArray(event.value)) this.traceChunks.push(...event.value);
    });
    await client.send("Tracing.start", {
      categories:
        "devtools.timeline,disabled-by-default-devtools.timeline,loading,blink.user_timing,v8",
      transferMode: "ReportEvents",
    });
    const infos = await this.session.listTabs();
    return infos.find((info) => info.handle === tab.handle)!;
  }

  /** Stop the active trace and return its JSON document. */
  async stopTrace(): Promise<{ trace: unknown; events: number; tab?: number }> {
    const client = this.traceClient;
    if (!client) {
      throw new BrowserPilotError(
        "No trace is recording.",
        'Start one with {action:"trace", op:"start"}.',
      );
    }
    this.traceClient = undefined;
    const completed = new Promise<void>((resolvePromise) => {
      client.once("Tracing.tracingComplete", () => resolvePromise());
    });
    await client.send("Tracing.end");
    await Promise.race([completed, sleep(10_000)]);
    await client.detach().catch(() => undefined);
    const events = this.traceChunks.map((chunk) => {
      try {
        return JSON.parse(chunk) as unknown;
      } catch {
        return { name: "unparsed", args: { raw: chunk } };
      }
    });
    this.traceChunks = [];
    const tab = this.traceTab;
    this.traceTab = undefined;
    return { trace: { traceEvents: events }, events: events.length, tab };
  }
}
