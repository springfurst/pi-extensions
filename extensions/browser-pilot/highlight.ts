import { finalize, pageHeader } from "./output";
import type { BrowserPilotSession } from "./session";
import { locatorFor, targetLabel } from "./tool-helpers";
import type { BrowserPilotConfig, BrowserPilotParams, BrowserPilotToolResult } from "./types";

export async function highlightResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  const duration = Math.min(Math.max(params.duration_ms ?? 1200, 100), 10_000);
  const color = params.color ?? "#ff5c5c";
  const handle = await locatorFor(session, tab, params, timeout).waitHandle();
  try {
    await handle.evaluate(
      (element, options) => {
        const target = element as HTMLElement;
        const previousOutline = target.style.outline;
        const previousOffset = target.style.outlineOffset;
        target.style.outline = `3px solid ${options.color}`;
        target.style.outlineOffset = "2px";
        setTimeout(() => {
          target.style.outline = previousOutline;
          target.style.outlineOffset = previousOffset;
        }, options.duration);
      },
      { color, duration },
    );
  } finally {
    await handle.dispose().catch(() => undefined);
  }
  tab.lastUsed = Date.now();
  session.persist();
  return finalize(
    [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      `Highlighted ${targetLabel(params)} for ${duration}ms.`,
    ].join("\n"),
    {
      action: "highlight",
      tab: tab.handle,
      url: tab.page.url(),
      target: targetLabel(params),
      durationMs: duration,
      color,
    },
  );
}
