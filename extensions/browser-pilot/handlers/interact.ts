import { existsSync } from "node:fs";
import type { ElementHandle, KeyInput } from "puppeteer-core";
import { detectChallenge } from "../challenge";
import { finalize, hint, pageHeader } from "../output";
import type { BrowserPilotSession } from "../session";
import {
  appendChallenge,
  locatorFor,
  pressKeyCombo,
  resolvePath,
  resolveSelectValues,
  resolveTypedText,
  selectOptionInfo,
  sleep,
  targetLabel,
} from "../tool-helpers";
import type {
  BrowserPilotConfig,
  BrowserPilotContext,
  BrowserPilotParams,
  BrowserPilotToolResult,
} from "../types";
import { BrowserPilotError } from "../types";

export async function clickResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  const humanize = params.humanize ?? config.humanize;
  const locator = locatorFor(session, tab, params, timeout)
    .setVisibility("visible")
    .setWaitForEnabled(true)
    .setEnsureElementIsInTheViewport(true)
    .setWaitForStableBoundingBox(true);
  const beforeUrl = tab.page.url();
  if (humanize) {
    const handle = await locator.waitHandle();
    const box = await handle.boundingBox();
    if (box) {
      await tab.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
    }
  }
  const modifiers = (params.modifiers ?? []) as KeyInput[];
  for (const modifier of modifiers) await tab.page.keyboard.down(modifier);
  try {
    await locator.click({
      button: params.button ?? "left",
      count: params.click_count ?? 1,
      delay: humanize ? 20 : 0,
    });
  } finally {
    for (const modifier of [...modifiers].reverse()) await tab.page.keyboard.up(modifier);
  }
  await sleep(150);
  const afterUrl = tab.page.url();
  if (afterUrl !== beforeUrl) {
    session.refs.clear();
    session.snapshotCount++;
  }
  const challenge = await detectChallenge(tab.page).catch(() => undefined);
  session.challenge = challenge;
  tab.lastUsed = Date.now();
  session.persist();
  const lines = [
    pageHeader(tab.handle, afterUrl, await tab.page.title().catch(() => "")),
    `Clicked ${targetLabel(params)}.`,
  ];
  if (afterUrl !== beforeUrl) {
    lines.push("", hint("the page navigated; refs are now stale. Run snapshot again."));
  }
  appendChallenge(lines, challenge);
  return finalize(lines.join("\n"), {
    action: "click",
    tab: tab.handle,
    url: afterUrl,
    title: await tab.page.title().catch(() => ""),
    target: targetLabel(params),
    challenge,
  });
}

export async function typeResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const text = resolveTypedText(params, ctx.cwd);
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  const humanize = params.humanize ?? config.humanize;
  const locator = locatorFor(session, tab, params, timeout)
    .setVisibility("visible")
    .setWaitForEnabled(true)
    .setEnsureElementIsInTheViewport(true);
  if (humanize || (params.delay_ms ?? 0) > 0) {
    await locator.click();
    if (params.clear !== false) {
      const selectAll = process.platform === "darwin" ? "Meta" : "Control";
      await tab.page.keyboard.down(selectAll);
      await tab.page.keyboard.press("A");
      await tab.page.keyboard.up(selectAll);
    } else {
      await tab.page.keyboard.press("End");
    }
    await tab.page.keyboard.type(text, { delay: params.delay_ms ?? 20 });
  } else if (params.clear === false) {
    await locator.click();
    await tab.page.keyboard.press("End");
    await tab.page.keyboard.type(text);
  } else {
    await locator.fill(text);
  }
  if (params.submit) await tab.page.keyboard.press("Enter");
  tab.lastUsed = Date.now();
  session.persist();
  const challenge = params.submit
    ? await detectChallenge(tab.page).catch(() => undefined)
    : undefined;
  if (challenge) session.challenge = challenge;
  const lines = [
    pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
    `Typed ${text.length} characters into ${targetLabel(params)}.`,
  ];
  if (params.submit) lines.push("Pressed Enter.");
  appendChallenge(lines, challenge);
  lines.push(
    "",
    hint('run {action:"snapshot"} if the page changed, or {action:"wait"} for a result.'),
  );
  return finalize(lines.join("\n"), {
    action: "type",
    tab: tab.handle,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
    target: targetLabel(params),
    textLength: text.length,
    challenge,
  });
}

export async function pressResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  if (params.ref || params.selector) {
    const locator = locatorFor(session, tab, params, timeout)
      .setVisibility("visible")
      .setWaitForEnabled(true);
    await locator.click();
  }
  await pressKeyCombo(tab.page, params.key!);
  tab.lastUsed = Date.now();
  session.persist();
  return finalize(
    [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      `Pressed ${params.key}.`,
    ].join("\n"),
    { action: "press", tab: tab.handle, url: tab.page.url(), key: params.key },
  );
}

export async function selectResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  const locator = locatorFor(session, tab, params, timeout)
    .setVisibility("visible")
    .setWaitForEnabled(true);
  const handle = (await locator.waitHandle()) as ElementHandle<HTMLSelectElement>;
  const options = await selectOptionInfo(handle);
  const requested = params.values ?? [];
  const { values, missing } = resolveSelectValues(options, requested);
  if (values.length === 0) {
    const available = options
      .slice(0, 10)
      .map((option) => `${option.label || option.value}=${JSON.stringify(option.value)}`)
      .join(", ");
    throw new BrowserPilotError(
      `No option matched ${requested.map((value) => JSON.stringify(value)).join(", ")}.`,
      `Pass an option value or label. Available: ${available || "(none)"}`,
    );
  }
  const selected = await handle.select(...values);
  tab.lastUsed = Date.now();
  session.persist();
  const lines = [
    pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
    `Selected: ${selected.join(", ") || "(none)"}`,
  ];
  if (missing.length > 0) {
    lines.push(`Not found: ${missing.map((value) => JSON.stringify(value)).join(", ")}`);
  }
  return finalize(lines.join("\n"), {
    action: "select",
    tab: tab.handle,
    url: tab.page.url(),
    target: targetLabel(params),
    selected,
    missing,
  });
}

export async function scrollResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  if (params.ref || params.selector) {
    const handle = await locatorFor(
      session,
      tab,
      params,
      session.config.actionTimeoutSeconds * 1000,
    ).waitHandle();
    await handle.evaluate((element) => {
      element.scrollIntoView({ block: "center", inline: "center" });
    });
  } else {
    await tab.page.evaluate(
      ({ direction, amount }) => {
        if (direction === "top") window.scrollTo(0, 0);
        else if (direction === "bottom") {
          window.scrollTo(0, document.documentElement.scrollHeight);
        } else {
          window.scrollBy(0, direction === "up" ? -amount : amount);
        }
      },
      {
        direction:
          params.direction === "up" || params.direction === "top" || params.direction === "bottom"
            ? params.direction
            : "down",
        amount: params.amount ?? 500,
      },
    );
  }
  tab.lastUsed = Date.now();
  session.persist();
  const position = await tab.page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    height: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
  }));
  return finalize(
    [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      `Scroll: x=${position.x} y=${position.y} height=${position.height} viewport=${position.viewport}`,
    ].join("\n"),
    { action: "scroll", tab: tab.handle, url: tab.page.url(), position },
  );
}

export async function hoverResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  await locatorFor(session, tab, params, timeout)
    .setVisibility("visible")
    .setEnsureElementIsInTheViewport(true)
    .hover();
  tab.lastUsed = Date.now();
  session.persist();
  return finalize(
    [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      `Hovered ${targetLabel(params)}.`,
    ].join("\n"),
    { action: "hover", tab: tab.handle, url: tab.page.url(), target: targetLabel(params) },
  );
}

export async function uploadResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  const files = (params.files ?? []).map((file) => resolvePath(ctx.cwd, file));
  for (const file of files) {
    if (!existsSync(file)) {
      throw new BrowserPilotError(
        `Upload file not found: ${file}`,
        "Pass an absolute path or a path relative to the working directory.",
      );
    }
  }
  const locator = locatorFor(session, tab, params, timeout)
    .setVisibility("visible")
    .setWaitForEnabled(true);
  const handle = (await locator.waitHandle()) as ElementHandle<HTMLInputElement>;
  await handle.uploadFile(...files);
  tab.lastUsed = Date.now();
  session.persist();
  return finalize(
    [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      `Uploaded ${files.length} file(s) to ${targetLabel(params)}:`,
      ...files.map((file) => `  ${file}`),
    ].join("\n"),
    {
      action: "upload",
      tab: tab.handle,
      url: tab.page.url(),
      title: await tab.page.title().catch(() => ""),
      target: targetLabel(params),
      files,
    },
  );
}
