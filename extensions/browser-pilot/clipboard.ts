import { finalize, pageHeader } from "./output";
import type { BrowserPilotSession } from "./session";
import { resolveTypedText } from "./tool-helpers";
import type { BrowserPilotContext, BrowserPilotParams, BrowserPilotToolResult } from "./types";

export async function clipboardResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const op = String(params.op);
  const permissions = ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"];
  await session.setPermissions(permissions, params.origin, params.tab);
  if (op === "read") {
    const text = await tab.page.evaluate(() => navigator.clipboard.readText());
    return finalize(
      [
        pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
        text ? text : "(clipboard is empty)",
      ].join("\n"),
      {
        action: "clipboard",
        op,
        tab: tab.handle,
        url: tab.page.url(),
        textLength: text.length,
      },
    );
  }
  const text = resolveTypedText(params, ctx.cwd, "clipboard");
  await tab.page.evaluate((value) => navigator.clipboard.writeText(value), text);
  return finalize(
    [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      `Wrote ${text.length} characters to the clipboard.`,
    ].join("\n"),
    {
      action: "clipboard",
      op,
      tab: tab.handle,
      url: tab.page.url(),
      textLength: text.length,
    },
  );
}
