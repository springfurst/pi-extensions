import type { Page } from "puppeteer-core";
import { finalize, pageHeader, previewText } from "./output";
import type { BrowserPilotSession } from "./session";
import { resolveTypedText } from "./tool-helpers";
import type { BrowserPilotContext, BrowserPilotParams, BrowserPilotToolResult } from "./types";
import { BrowserPilotError } from "./types";

/** Clipboard calls require a focused document, which a background window is not. */
async function withFocusEmulation<T>(page: Page, run: () => Promise<T>): Promise<T> {
  await page.bringToFront().catch(() => undefined);
  const client = await page.createCDPSession();
  try {
    await client
      .send("Emulation.setFocusEmulationEnabled", { enabled: true })
      .catch(() => undefined);
    return await run();
  } finally {
    await client
      .send("Emulation.setFocusEmulationEnabled", { enabled: false })
      .catch(() => undefined);
    await client.detach().catch(() => undefined);
  }
}

function isFocusError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not focused|NotAllowedError|Document is not focused/i.test(message);
}

export async function clipboardResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const op = String(params.operation);
  const permissions = ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"];
  await session.setPermissions(permissions, params.origin, params.tab);
  if (op === "read") {
    let text: string;
    try {
      text = await withFocusEmulation(tab.page, () =>
        tab.page.evaluate(() => navigator.clipboard.readText()),
      );
    } catch (error) {
      if (!isFocusError(error)) throw error;
      throw new BrowserPilotError(
        "The clipboard could not be read because the page is not focused.",
        'Bring the Chrome window to the front, then retry {action:"clipboard", params:{operation:"read"}}.',
      );
    }
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
        preview: text ? previewText(text, 120) : "(clipboard is empty)",
      },
    );
  }
  const text = resolveTypedText(params, ctx.cwd, "clipboard");
  try {
    await withFocusEmulation(tab.page, () =>
      tab.page.evaluate((value) => navigator.clipboard.writeText(value), text),
    );
  } catch (error) {
    if (!isFocusError(error)) throw error;
    throw new BrowserPilotError(
      "The clipboard could not be written because the page is not focused.",
      'Bring the Chrome window to the front, then retry {action:"clipboard", params:{operation:"write"}}.',
    );
  }
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
      preview: previewText(text, 120),
    },
  );
}
