import { finalize, hint, pageHeader } from "./output";
import type { BrowserPilotSession } from "./session";
import type { BrowserPilotParams, BrowserPilotToolResult } from "./types";

export async function framesResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const op = String(params.op);
  if (op === "list") {
    const frames = session.listFrames(tab);
    const lines = [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      ...frames.map(
        (frame) =>
          `${frame.selected ? "*" : " "} ${frame.index}${frame.main ? " main" : ""} ${frame.url}${frame.name ? ` (${frame.name})` : ""}`,
      ),
      "",
      hint('use frames {op:"select", frame:1} to scope read, eval, and screenshot.'),
    ];
    return finalize(lines.join("\n"), {
      action: "frames",
      op,
      tab: tab.handle,
      url: tab.page.url(),
      frames,
    });
  }
  if (op === "main") {
    session.selectFrame(tab, undefined);
    session.persist();
    return finalize(
      [
        pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
        "Selected the main frame.",
      ].join("\n"),
      { action: "frames", op, tab: tab.handle, url: tab.page.url() },
    );
  }
  const index = params.frame!;
  const frame = session.selectFrame(tab, index);
  session.persist();
  return finalize(
    [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      `Selected frame ${index}: ${frame.url()}`,
    ].join("\n"),
    {
      action: "frames",
      op,
      tab: tab.handle,
      url: tab.page.url(),
      frame: index,
      frameUrl: frame.url(),
    },
  );
}
