import { finalize, pageHeader } from "./output";
import type { BrowserPilotSession } from "./session";
import { formatBytes } from "./tool-helpers";
import type { BrowserPilotParams, BrowserPilotToolResult } from "./types";

export async function metricsResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const metrics = await tab.page.metrics();
  const timing = await tab.page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as
      PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    return {
      domContentLoaded: navigation ? Math.round(navigation.domContentLoadedEventEnd) : undefined,
      load: navigation ? Math.round(navigation.loadEventEnd) : undefined,
      responseEnd: navigation ? Math.round(navigation.responseEnd) : undefined,
      resources: resources.length,
      transferSize: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
    };
  });
  const heap = metrics.JSHeapUsedSize ?? 0;
  const lines = [
    pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
    `Heap: ${formatBytes(heap)} used${metrics.JSHeapTotalSize ? ` of ${formatBytes(metrics.JSHeapTotalSize)}` : ""}`,
    `DOM: ${metrics.Nodes ?? "?"} nodes · ${metrics.Documents ?? "?"} documents · ${metrics.Frames ?? "?"} frames · ${metrics.JSEventListeners ?? "?"} listeners`,
    `Layout: ${metrics.LayoutCount ?? 0} layouts · ${metrics.RecalcStyleCount ?? 0} style recalcs`,
    timing.domContentLoaded !== undefined || timing.load !== undefined
      ? `Navigation: response ${timing.responseEnd ?? "?"}ms · DOMContentLoaded ${timing.domContentLoaded ?? "?"}ms · load ${timing.load ?? "?"}ms`
      : "Navigation: no navigation timing entry",
    `Resources: ${timing.resources} entries · ${formatBytes(timing.transferSize)} transfer`,
  ];
  return finalize(lines.join("\n"), {
    action: "metrics",
    tab: tab.handle,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
    metrics,
    timing,
  });
}
