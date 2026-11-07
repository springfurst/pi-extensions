import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { KeyInput } from "puppeteer-core";
import { USAGE_SCHEMA_VERSION, createFileUsageLogger, type UsageRecord } from "../../lib/logging";
import { PI_VERSION, TOOL_VERSION } from "../../lib/version";
import { renderHelp, validateAction, type ActionName } from "./actions";
import { detectChallenge, waitForHuman } from "./challenge";
import { loadBrowserPilotConfig } from "./config";
import { readPageContent } from "./content";
import { evaluateInPage, formatEvalValue } from "./eval";
import { shouldRunHeadless } from "./launcher";
import {
  capForModel,
  capText,
  formatChallenge,
  formatTabs,
  hint,
  pageHeader,
  suggestedNext,
  truncationHint,
} from "./output";
import { getBrowserPilotSession, previewProfile, type BrowserPilotSession } from "./session";
import { refSelector, snapshotPage } from "./snapshot";
import type {
  BrowserPilotConfig,
  BrowserPilotContext,
  BrowserPilotDetails,
  BrowserPilotParams,
  ChallengeInfo,
} from "./types";
import { BrowserPilotError } from "./types";

const TINY_ACTIONS = new Set<ActionName>([
  "help",
  "status",
  "open",
  "close",
  "tabs",
  "click",
  "type",
  "press",
  "select",
  "scroll",
  "hover",
  "navigate",
  "wait",
  "screenshot",
  "dialog",
]);

const MAX_INPUT_FILE_BYTES = 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

export interface BrowserPilotToolResult {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details: BrowserPilotDetails;
  isError?: boolean;
}

/** Run one browser-pilot action, including validation, logging, and output caps. */
export async function executeBrowserPilot(
  params: BrowserPilotParams,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const startedAt = Date.now();
  const config = loadBrowserPilotConfig(ctx.cwd, {
    agentDir: ctx.agentDir,
    projectTrusted: ctx.trusted,
  });
  const sessionId = ctx.sessionId ?? `pid-${process.pid}`;
  const logger = config.logging.enabled
    ? createFileUsageLogger({
        cwd: ctx.cwd,
        agentDir: ctx.agentDir,
        tool: "browser-pilot",
        config: config.logging,
      })
    : undefined;
  let session: BrowserPilotSession | undefined;
  let details: BrowserPilotDetails = { action: params.action };
  let outputText = "";

  try {
    if (params.action === "help") {
      outputText = renderHelp(params.topic);
      details = { action: "help" };
      return finalize(outputText, details);
    }

    validateAction(params.action, params as unknown as Record<string, unknown>);
    session = getBrowserPilotSession({
      sessionId,
      agentDir: ctx.agentDir,
      cwd: ctx.cwd,
      config,
    });

    if (params.action === "status") {
      const status = await statusResult(session, config);
      outputText = status.text;
      details = status.details;
      return finalize(outputText, details);
    }

    const result = await dispatch(params, session, config, ctx);
    outputText = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    details = result.details;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hintText = error instanceof BrowserPilotError ? error.hint : undefined;
    const current = session ? currentPageLine(session) : undefined;
    outputText = [message, hintText ? hint(hintText) : undefined, current]
      .filter((line): line is string => !!line)
      .join("\n\n");
    details = {
      ...details,
      ...(await pageDetails(session)),
      error: message,
    };
    return {
      content: [{ type: "text", text: capForModel(outputText).text }],
      details,
      isError: true,
    };
  } finally {
    if (logger) {
      try {
        logger.log(
          buildUsageRecord({
            params,
            config,
            session,
            details,
            outputText,
            durationMs: Date.now() - startedAt,
            error: details.error,
            cwd: ctx.cwd,
            sessionId,
            sessionFile: ctx.sessionFile,
            sessionName: ctx.sessionName,
            toolCallId: ctx.toolCallId,
            mode: ctx.mode,
          }),
        );
      } catch {
        // Logging is best-effort by contract.
      }
    }
  }
}

async function dispatch(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  if (session.pendingDialog && !["dialog", "status", "close", "help"].includes(params.action)) {
    throw new BrowserPilotError(
      `A ${session.pendingDialog.type} dialog is open: ${session.pendingDialog.message}`,
      'Resolve it with {action:"dialog", op:"accept"} or {action:"dialog", op:"dismiss"}.',
    );
  }
  switch (params.action) {
    case "open":
      return openResult(params, session, config, ctx);
    case "close":
      return closeResult(params, session, config);
    case "navigate":
      return navigateResult(params, session, ctx);
    case "tabs":
      return tabsResult(params, session, config);
    case "snapshot":
      return snapshotResult(params, session, config);
    case "read":
      return readResult(params, session, config, ctx);
    case "eval":
      return evalResult(params, session, config, ctx);
    case "click":
      return clickResult(params, session, config);
    case "type":
      return typeResult(params, session, config, ctx);
    case "press":
      return pressResult(params, session, config);
    case "select":
      return selectResult(params, session, config);
    case "scroll":
      return scrollResult(params, session);
    case "hover":
      return hoverResult(params, session, config);
    case "wait":
      return waitResult(params, session, config, ctx);
    case "screenshot":
      return screenshotResult(params, session, config);
    case "console":
      return consoleResult(params, session);
    case "network":
      return networkResult(params, session);
    case "dialog":
      return dialogResult(params, session);
    case "help":
    case "status":
      throw new BrowserPilotError(`Action ${params.action} is handled before dispatch.`);
  }
}

async function statusResult(
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<{ text: string; details: BrowserPilotDetails }> {
  const profile =
    session.profile ?? previewProfile(config, session.sessionId, session.agentDir, session.cwd);
  const mode = shouldRunHeadless(config) ? "headless" : "headful";
  if (!session.instance) {
    const text = [
      "Browser: not running",
      `Profile: ${profile.label} (${profile.userDataDir}) ${profile.persistent ? "[persistent]" : "[isolated]"}`,
      `Mode: ${mode}`,
      "Tabs: 0",
      "",
      hint('call {action:"open"} to start Chrome.'),
    ].join("\n");
    return {
      text,
      details: {
        action: "status",
        profile: profile.label,
        userDataDir: profile.userDataDir,
        headless: shouldRunHeadless(config),
      },
    };
  }

  const tabs = session.browser?.connected ? await session.listTabs() : [];
  const current = tabs.find((tab) => tab.current);
  let challenge: ChallengeInfo | undefined;
  if (session.browser?.connected && session.current !== undefined && !session.pendingDialog) {
    const tab = session.tabs.get(session.current);
    if (tab && !tab.page.isClosed()) {
      challenge = await detectChallenge(tab.page).catch(() => undefined);
      session.challenge = challenge;
    }
  }
  const lines = [
    `Browser: ${session.browser?.connected ? "running" : "disconnected"}`,
    `Chrome: ${session.instance.chromeVersion ?? "unknown"}`,
    `Profile: ${profile.label} (${profile.userDataDir}) ${profile.persistent ? "[persistent]" : "[isolated]"}`,
    `Process: pid ${session.instance.pid}, port ${session.instance.port}`,
    `Mode: ${mode}`,
    formatTabs(tabs, config.maxTabs),
  ];
  if (challenge) lines.push(`Challenge: ${formatChallenge(challenge)}`);
  if (session.pendingDialog) {
    lines.push(`Dialog: ${session.pendingDialog.type} "${session.pendingDialog.message}"`);
  }
  if (!session.browser?.connected) {
    lines.push("", hint("the next action will try to reconnect."));
  } else if (challenge) {
    lines.push(
      "",
      hint('solve the challenge in the Chrome window, then run {action:"wait", for:"human"}.'),
    );
  }
  return {
    text: lines.join("\n"),
    details: {
      action: "status",
      profile: profile.label,
      userDataDir: profile.userDataDir,
      pid: session.instance.pid,
      port: session.instance.port,
      chromeVersion: session.instance.chromeVersion,
      headless: shouldRunHeadless(config),
      tabs,
      challenge,
      tab: current?.handle,
      url: current?.url,
      title: current?.title,
      pendingDialog: session.pendingDialog,
    },
  };
}

async function openResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  if (params.profile && params.profile !== session.config.profile) {
    if (session.instance || session.browser) {
      throw new BrowserPilotError(
        `This session is already using profile "${session.config.profile}".`,
        "Close the browser first, then open with the new profile.",
      );
    }
    session.config = { ...session.config, profile: params.profile };
  }
  await session.ensure(ctx.signal);
  if (params.url) {
    const nav = await session.navigate(
      params.url,
      undefined,
      params.wait_until,
      params.timeout_ms,
      ctx.signal,
      params.tab,
    );
    return navigateText(nav);
  }
  const tab = await session.ensureTab(params.tab);
  tab.lastUsed = Date.now();
  await tab.page.bringToFront().catch(() => undefined);
  session.persist();
  const infos = await session.listTabs();
  const info = infos.find((candidate) => candidate.handle === tab.handle)!;
  const text = [
    pageHeader(info.handle, info.url, info.title),
    "",
    formatTabs(infos, config.maxTabs),
    "",
    hint('run {action:"snapshot"} to see interactive elements, or {action:"navigate", url:"..."}.'),
  ].join("\n");
  return finalize(text, {
    action: "open",
    tab: info.handle,
    url: info.url,
    title: info.title,
    tabs: infos,
  });
}

async function closeResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const target = params.target;
  if (target === "browser") {
    if (!session.instance) {
      return finalize("No browser was running.", { action: "close", target });
    }
    const profile = session.profile?.label;
    await session.dispose();
    return finalize(`Closed the browser${profile ? ` (profile ${profile})` : ""}.`, {
      action: "close",
      target,
    });
  }
  if (target === "tabs") {
    const victims = [...session.tabs.values()].filter((tab) => tab.owned);
    for (const tab of victims) await session.closeTab(tab.handle);
    const infos = await session.listTabs();
    return finalize(
      `Closed ${victims.length} agent tab(s).\n\n${formatTabs(infos, config.maxTabs)}`,
      {
        action: "close",
        target,
        tabs: infos,
      },
    );
  }
  const handle = params.tab ?? session.current;
  if (handle === undefined) {
    throw new BrowserPilotError(
      "No tab is open to close.",
      'Use {action:"close", target:"browser"} to close the browser.',
    );
  }
  await session.closeTab(handle);
  const infos = await session.listTabs();
  return finalize(`Closed tab ${handle}.\n\n${formatTabs(infos, config.maxTabs)}`, {
    action: "close",
    target: "tab",
    tab: handle,
    tabs: infos,
  });
}

async function navigateResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const direction =
    params.direction === "back" || params.direction === "forward" || params.direction === "reload"
      ? params.direction
      : undefined;
  const nav = await session.navigate(
    params.url,
    direction,
    params.wait_until,
    params.timeout_ms,
    ctx.signal,
    params.tab,
  );
  return navigateText(nav);
}

function navigateText(
  nav: Awaited<ReturnType<BrowserPilotSession["navigate"]>>,
): BrowserPilotToolResult {
  const lines = [pageHeader(nav.tab.handle, nav.url, nav.title), `Status: ${nav.status}`];
  if (nav.note) lines.push(nav.note);
  if (nav.challenge) {
    lines.push("", formatChallenge(nav.challenge)!);
    lines.push(
      hint('solve the challenge in the Chrome window, then run {action:"wait", for:"human"}.'),
    );
  }
  lines.push("", suggestedNext('{action:"snapshot"} or {action:"read"}.'));
  return finalize(lines.join("\n"), {
    action: "navigate",
    tab: nav.tab.handle,
    url: nav.url,
    title: nav.title,
    status: nav.status,
    challenge: nav.challenge,
    tabs: undefined,
  });
}

async function tabsResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const op = String(params.op);
  if (op === "list" && !session.instance) {
    return finalize("No browser is running.\n\n" + hint('call {action:"open"} first.'), {
      action: "tabs",
      op,
    });
  }
  await session.ensure();
  if (op === "new") {
    const tab = await session.newTab(params.url);
    const infos = await session.listTabs();
    const info = infos.find((candidate) => candidate.handle === tab.handle)!;
    return finalize(`Opened tab ${tab.handle}.\n\n${formatTabs(infos, config.maxTabs)}`, {
      action: "tabs",
      op,
      tab: info.handle,
      url: info.url,
      title: info.title,
      tabs: infos,
    });
  }
  if (op === "select") {
    const info = await session.selectTab(params.tab!);
    return finalize(
      `Selected tab ${info.handle}.\n\n${pageHeader(info.handle, info.url, info.title)}`,
      {
        action: "tabs",
        op,
        tab: info.handle,
        url: info.url,
        title: info.title,
      },
    );
  }
  if (op === "close") {
    const handle = params.tab!;
    await session.closeTab(handle);
    const infos = await session.listTabs();
    return finalize(`Closed tab ${handle}.\n\n${formatTabs(infos, config.maxTabs)}`, {
      action: "tabs",
      op,
      tab: handle,
      tabs: infos,
    });
  }
  if (op === "close_others") {
    const count = await session.closeOtherTabs();
    const infos = await session.listTabs();
    return finalize(`Closed ${count} other agent tab(s).\n\n${formatTabs(infos, config.maxTabs)}`, {
      action: "tabs",
      op,
      tabs: infos,
    });
  }
  if (op === "cleanup") {
    const count = await session.cleanupTabs();
    const infos = await session.listTabs();
    return finalize(`Closed ${count} idle agent tab(s).\n\n${formatTabs(infos, config.maxTabs)}`, {
      action: "tabs",
      op,
      tabs: infos,
    });
  }
  const infos = await session.listTabs();
  const current = infos.find((tab) => tab.current);
  return finalize(formatTabs(infos, config.maxTabs), {
    action: "tabs",
    op: "list",
    tabs: infos,
    tab: current?.handle,
    url: current?.url,
    title: current?.title,
  });
}

async function snapshotResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const result = await snapshotPage(tab.page, {
    interactive: params.interactive ?? true,
    maxNodes: params.max_nodes ?? config.maxSnapshotNodes,
  });
  session.snapshotCount++;
  session.refs.clear();
  session.persist();
  const body = result.lines.length > 0 ? result.lines.join("\n") : "No matching elements found.";
  const lines = [
    pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
    "",
    body,
  ];
  if (result.truncated) {
    lines.push(
      "",
      `[Snapshot truncated at ${result.count} nodes; raise max_nodes or scope it with selector.]`,
    );
  }
  lines.push("", hint("use ref with click/type. Refs expire after navigation or a new snapshot."));
  const challenge = await detectChallenge(tab.page).catch(() => undefined);
  session.challenge = challenge;
  if (challenge) {
    lines.push("", formatChallenge(challenge)!);
    lines.push(hint('solve it in the Chrome window, then run {action:"wait", for:"human"}.'));
  }
  return finalize(lines.join("\n"), {
    action: "snapshot",
    tab: tab.handle,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
    challenge,
    snapshotNodes: result.count,
  });
}

async function readResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const content = await readPageContent(tab.page, {
    format: params.format === "text" || params.format === "html" ? params.format : "markdown",
    selector: params.selector,
  });
  const maxChars = params.max_chars ?? config.maxReadChars;
  let savedPath: string | undefined;
  if (params.save_path) {
    savedPath = resolvePath(ctx.cwd, params.save_path);
    mkdirSync(dirname(savedPath), { recursive: true });
    writeFileSync(savedPath, content.text, "utf-8");
  }
  const capped = capText(content.text, maxChars);
  const model = capForModel(capped.text);
  const lines = [
    pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
    `Format: ${content.format} · ${content.chars} characters`,
    "",
    model.text || '(no readable text found; try format:"html" or eval.)',
  ];
  if (capped.truncated) {
    lines.push("", truncationHint(capped.chars, maxChars, savedPath));
  } else if (model.truncated) {
    lines.push(
      "",
      "[Output truncated by the model limit; use max_chars or save_path to narrow it.]",
    );
  }
  if (savedPath) lines.push("", `[Saved to ${savedPath}]`);
  const challenge = await detectChallenge(tab.page).catch(() => undefined);
  session.challenge = challenge;
  if (challenge) {
    lines.push("", formatChallenge(challenge)!);
    lines.push(hint('solve it in the Chrome window, then run {action:"wait", for:"human"}.'));
  }
  return finalize(lines.join("\n"), {
    action: "read",
    tab: tab.handle,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
    format: content.format,
    chars: content.chars,
    truncated: capped.truncated || model.truncated,
    savedPath,
    challenge,
  });
}

async function evalResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const source = params.script_path
    ? readInputFile(ctx.cwd, params.script_path)
    : params.expression!;
  const timeoutMs = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  const result = await evaluateInPage(tab.page, {
    source,
    awaitPromise: params.await_promise ?? true,
    timeoutMs,
  });
  const text = formatEvalValue(result);
  const maxChars = params.max_chars ?? config.maxEvalChars;
  let savedPath: string | undefined;
  if (params.save_path) {
    savedPath = resolvePath(ctx.cwd, params.save_path);
    mkdirSync(dirname(savedPath), { recursive: true });
    writeFileSync(savedPath, text, "utf-8");
  }
  const capped = capText(text, maxChars);
  const model = capForModel(capped.text);
  const lines = [
    pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
    `Result: ${result.type}${result.description ? ` · ${result.description}` : ""}`,
    "",
    model.text,
  ];
  if (capped.truncated) {
    lines.push("", truncationHint(capped.chars, maxChars, savedPath));
  } else if (model.truncated) {
    lines.push(
      "",
      "[Output truncated by the model limit; use max_chars or save_path to narrow it.]",
    );
  }
  if (savedPath) lines.push("", `[Saved to ${savedPath}]`);
  return finalize(lines.join("\n"), {
    action: "eval",
    tab: tab.handle,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
    resultType: result.type,
    chars: text.length,
    truncated: capped.truncated || model.truncated,
    savedPath,
  });
}

async function clickResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const selector = resolveTargetSelector(params);
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  const humanize = params.humanize ?? config.humanize;
  const locator = tab.page
    .locator(selector)
    .setTimeout(timeout)
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
  if (challenge) {
    lines.push("", formatChallenge(challenge)!);
    lines.push(hint('solve it in the Chrome window, then run {action:"wait", for:"human"}.'));
  }
  return finalize(lines.join("\n"), {
    action: "click",
    tab: tab.handle,
    url: afterUrl,
    title: await tab.page.title().catch(() => ""),
    target: targetLabel(params),
    challenge,
  });
}

async function typeResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const selector = resolveTargetSelector(params);
  const text = resolveTypedText(params, ctx.cwd);
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  const humanize = params.humanize ?? config.humanize;
  const locator = tab.page
    .locator(selector)
    .setTimeout(timeout)
    .setVisibility("visible")
    .setWaitForEnabled(true)
    .setEnsureElementIsInTheViewport(true);
  if (humanize || (params.delay_ms ?? 0) > 0) {
    await locator.click();
    if (params.clear !== false) {
      await tab.page.keyboard.down("Control");
      await tab.page.keyboard.press("A");
      await tab.page.keyboard.up("Control");
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
  if (challenge) {
    lines.push("", formatChallenge(challenge)!);
    lines.push(hint('solve it in the Chrome window, then run {action:"wait", for:"human"}.'));
  }
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

async function pressResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  if (params.ref || params.selector) {
    const selector = resolveTargetSelector(params);
    const locator = tab.page
      .locator(selector)
      .setTimeout(timeout)
      .setVisibility("visible")
      .setWaitForEnabled(true);
    await locator.click();
  }
  await tab.page.keyboard.press(params.key! as KeyInput);
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

async function selectResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const selector = resolveTargetSelector(params);
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  const locator = tab.page
    .locator(selector)
    .setTimeout(timeout)
    .setVisibility("visible")
    .setWaitForEnabled(true);
  const handle = await locator.waitHandle();
  const selected = await handle.select(...(params.values ?? []));
  tab.lastUsed = Date.now();
  session.persist();
  return finalize(
    [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      `Selected: ${selected.join(", ") || "(none)"}`,
    ].join("\n"),
    {
      action: "select",
      tab: tab.handle,
      url: tab.page.url(),
      target: targetLabel(params),
      selected,
    },
  );
}

async function scrollResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  if (params.ref || params.selector) {
    const selector = resolveTargetSelector(params);
    const handle = await tab.page.locator(selector).waitHandle();
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

async function hoverResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const selector = resolveTargetSelector(params);
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  await tab.page
    .locator(selector)
    .setTimeout(timeout)
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

async function waitResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const kind = params.for!;
  const timeout =
    params.timeout_ms ??
    (kind === "human" ? config.challengeWaitSeconds * 1000 : config.actionTimeoutSeconds * 1000);
  const started = Date.now();
  if (kind === "human") {
    let lastUpdate = 0;
    const result = await waitForHuman(tab.page, {
      timeoutMs: timeout,
      signal: ctx.signal,
      onProgress: (elapsed) => {
        if (Date.now() - lastUpdate < 5_000) return;
        lastUpdate = Date.now();
        void ctx.onUpdate?.({
          content: [
            {
              type: "text",
              text: `Waiting for human... ${Math.round(elapsed / 1000)}s`,
            },
          ],
          details: {
            action: "wait",
            tab: tab.handle,
            url: tab.page.url(),
            challenge: session.challenge,
          },
        });
      },
    });
    session.challenge = result.challenge;
    session.persist();
    if (!result.cleared) {
      throw new BrowserPilotError(
        `Timed out after ${Math.round(result.elapsedMs / 1000)}s waiting for the challenge to clear.`,
        'The challenge is still present. Solve it in the Chrome window, then run wait {for:"human"} again.',
      );
    }
    const text = result.initialChallenge
      ? `Challenge cleared after ${Math.round(result.elapsedMs / 1000)}s.`
      : `No blocking challenge was present after ${Math.round(result.elapsedMs / 1000)}s.`;
    return finalize(
      [pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")), text].join(
        "\n",
      ),
      {
        action: "wait",
        tab: tab.handle,
        url: tab.page.url(),
        title: await tab.page.title().catch(() => ""),
        challenge: result.challenge ?? result.initialChallenge,
        elapsedMs: result.elapsedMs,
      },
    );
  }

  if (kind === "selector") {
    await tab.page.waitForSelector(params.selector!, {
      visible: true,
      timeout,
      signal: ctx.signal,
    });
  } else if (kind === "text") {
    await tab.page.waitForFunction(
      (needle) => (document.body?.innerText ?? "").includes(needle),
      { timeout, signal: ctx.signal },
      params.text!,
    );
  } else if (kind === "url") {
    await tab.page.waitForFunction(
      (needle) => location.href.includes(needle),
      { timeout, signal: ctx.signal },
      params.url!,
    );
  } else if (kind === "network_idle") {
    await tab.page.waitForNetworkIdle({ idleTime: 500, timeout, signal: ctx.signal });
  } else if (kind === "function") {
    await tab.page.waitForFunction(`() => { return (${params.expression!}); }`, {
      timeout,
      signal: ctx.signal,
    });
  }
  tab.lastUsed = Date.now();
  session.persist();
  const elapsed = Date.now() - started;
  const challenge = await detectChallenge(tab.page).catch(() => undefined);
  session.challenge = challenge;
  const lines = [
    pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
    `Wait satisfied after ${elapsed}ms.`,
  ];
  if (challenge) {
    lines.push("", formatChallenge(challenge)!);
    lines.push(hint('solve it in the Chrome window, then run {action:"wait", for:"human"}.'));
  }
  return finalize(lines.join("\n"), {
    action: "wait",
    tab: tab.handle,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
    elapsedMs: elapsed,
    challenge,
  });
}

async function screenshotResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const format = params.format === "jpeg" || params.format === "webp" ? params.format : "png";
  const path =
    params.path !== undefined
      ? resolvePath(session.cwd, params.path)
      : join(
          config.screenshotsDir ?? join(session.agentDir, "browser-pilot", "screenshots"),
          `${timestamp()}-tab${tab.handle}.${format}`,
        );
  mkdirSync(dirname(path), { recursive: true });
  const quality = params.quality;
  if (params.selector) {
    const handle = await tab.page.$(params.selector);
    if (!handle) {
      throw new BrowserPilotError(
        `No element matched selector ${params.selector}.`,
        'Run {action:"snapshot"} to find a stable ref, or check the selector.',
      );
    }
    await handle.screenshot({ path, type: format, quality });
  } else {
    await tab.page.screenshot({
      path,
      type: format,
      quality,
      fullPage: params.full_page ?? false,
    });
  }
  const bytes = statSync(path).size;
  const dimensions = await tab.page.evaluate(() => ({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    page: {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    },
  }));
  const text = [
    pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
    `Screenshot: ${path}`,
    `Format: ${format} · ${bytes} bytes · viewport ${dimensions.viewport.width}×${dimensions.viewport.height} · page ${dimensions.page.width}×${dimensions.page.height}`,
  ].join("\n");
  const content: BrowserPilotToolResult["content"] = [{ type: "text", text }];
  if (params.inline && bytes <= MAX_INLINE_IMAGE_BYTES) {
    content.push({
      type: "image",
      data: readFileSync(path).toString("base64"),
      mimeType: `image/${format}`,
    });
  } else if (params.inline) {
    content[0] = {
      type: "text",
      text: `${text}\n\n[Image is ${bytes} bytes, above the ${MAX_INLINE_IMAGE_BYTES} byte inline cap.]`,
    };
  }
  return {
    content,
    details: {
      action: "screenshot",
      tab: tab.handle,
      url: tab.page.url(),
      title: await tab.page.title().catch(() => ""),
      savedPath: path,
      bytes,
      dimensions,
    },
  };
}

async function consoleResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  if (params.op === "clear") {
    const count = tab.console.length;
    tab.console.length = 0;
    return finalize(`Cleared ${count} console entries.`, {
      action: "console",
      op: "clear",
      tab: tab.handle,
      count,
    });
  }
  const limit = params.limit ?? 100;
  const entries = tab.console
    .filter((entry) => !params.level || entry.level === params.level)
    .slice(-limit);
  const body =
    entries.length > 0
      ? entries
          .map((entry) => {
            const location = entry.url
              ? ` (${entry.url}${entry.line !== undefined ? `:${entry.line}` : ""})`
              : "";
            return `[${entry.level}] ${entry.text}${location}`;
          })
          .join("\n")
      : "No console entries.";
  return finalize(
    [pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")), "", body].join(
      "\n",
    ),
    {
      action: "console",
      op: "read",
      tab: tab.handle,
      url: tab.page.url(),
      count: entries.length,
    },
  );
}

async function networkResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  if (params.op === "clear") {
    const count = tab.network.length;
    tab.network.length = 0;
    return finalize(`Cleared ${count} network entries.`, {
      action: "network",
      op: "clear",
      tab: tab.handle,
      count,
    });
  }
  const limit = params.limit ?? 100;
  const entries = tab.network
    .filter((entry) => !params.filter || entry.url.includes(params.filter))
    .slice(-limit);
  const body =
    entries.length > 0
      ? entries
          .map((entry) => {
            const status = entry.failed ? `FAILED ${entry.failed}` : (entry.status ?? "...");
            const meta = [
              entry.resourceType,
              entry.mimeType,
              entry.durationMs !== undefined ? `${entry.durationMs}ms` : undefined,
            ]
              .filter(Boolean)
              .join(" ");
            return `${status} ${entry.method} ${entry.url}${meta ? ` (${meta})` : ""}`;
          })
          .join("\n")
      : "No network entries.";
  return finalize(
    [pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")), "", body].join(
      "\n",
    ),
    {
      action: "network",
      op: "read",
      tab: tab.handle,
      url: tab.page.url(),
      count: entries.length,
    },
  );
}

async function dialogResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const result = await session.resolveDialog({
    op: params.op as "accept" | "dismiss" | "policy",
    text: params.text,
    policy: params.policy,
  });
  const text = result.dialog
    ? `${params.op === "accept" ? "Accepted" : "Dismissed"} ${result.dialog.type}: ${result.dialog.message}`
    : `Dialog policy: ${result.policy}`;
  return finalize(text, {
    action: "dialog",
    op: params.op,
    policy: result.policy,
    dialog: result.dialog,
  });
}

function finalize(text: string, details: BrowserPilotDetails): BrowserPilotToolResult {
  const capped = capForModel(text);
  const finalText = capped.truncated
    ? `${capped.text}\n\n[Output truncated by the model limit.]`
    : capped.text;
  return { content: [{ type: "text", text: finalText }], details };
}

function resolveTargetSelector(params: BrowserPilotParams): string {
  if (params.ref) {
    const selector = refSelector(params.ref);
    if (!selector) {
      throw new BrowserPilotError(
        `Invalid ref "${params.ref}".`,
        'Refs look like e12. Run {action:"snapshot"} to get fresh refs.',
      );
    }
    return selector;
  }
  if (params.selector) return params.selector;
  throw new BrowserPilotError(
    "This action requires ref or selector.",
    'Run {action:"snapshot"} to get refs.',
  );
}

function targetLabel(params: BrowserPilotParams): string {
  if (params.ref) return `ref ${params.ref}`;
  if (params.selector) return `selector ${params.selector}`;
  return "the target";
}

function resolveTypedText(params: BrowserPilotParams, cwd: string): string {
  if (params.text !== undefined) return params.text;
  if (params.text_file) return readInputFile(cwd, params.text_file);
  if (params.text_env) {
    const value = process.env[params.text_env];
    if (value === undefined) {
      throw new BrowserPilotError(
        `Environment variable ${params.text_env} is not set.`,
        "Set it in the environment before calling type, or pass text directly.",
      );
    }
    return value;
  }
  throw new BrowserPilotError("type requires text, text_file, or text_env.");
}

function readInputFile(cwd: string, path: string): string {
  const absolute = resolvePath(cwd, path);
  const size = statSync(absolute).size;
  if (size > MAX_INPUT_FILE_BYTES) {
    throw new BrowserPilotError(
      `Input file is ${size} bytes, above the ${MAX_INPUT_FILE_BYTES} byte cap.`,
      "Pass a smaller file or use an inline expression.",
    );
  }
  return readFileSync(absolute, "utf-8");
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function currentPageLine(session: BrowserPilotSession): string | undefined {
  if (session.current === undefined) return undefined;
  const tab = session.tabs.get(session.current);
  if (!tab || tab.page.isClosed()) return undefined;
  return `Current: Tab ${tab.handle} · ${tab.page.url()}`;
}

async function pageDetails(
  session: BrowserPilotSession | undefined,
): Promise<Partial<BrowserPilotDetails>> {
  if (!session || session.current === undefined) return {};
  const tab = session.tabs.get(session.current);
  if (!tab || tab.page.isClosed()) return { tab: session.current };
  return {
    tab: tab.handle,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
  };
}

interface UsageRecordOptions {
  params: BrowserPilotParams;
  config: BrowserPilotConfig;
  session?: BrowserPilotSession;
  details: BrowserPilotDetails;
  outputText: string;
  durationMs: number;
  error?: string;
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  toolCallId?: string;
  mode?: string;
}

function buildUsageRecord(options: UsageRecordOptions): UsageRecord {
  const { params, config, session, details, outputText, durationMs, error } = options;
  const safe = safeParams(params, config);
  const output = summarizeOutput(params.action, outputText, config);
  return {
    schema: USAGE_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    tool: "browser-pilot",
    toolVersion: TOOL_VERSION,
    piVersion: PI_VERSION,
    sessionId: session?.sessionId ?? options.sessionId,
    sessionFile: options.sessionFile,
    sessionName: options.sessionName,
    toolCallId: options.toolCallId,
    cwd: session?.cwd ?? options.cwd,
    mode: options.mode,
    durationMs,
    outcome: error ? "error" : "ok",
    error,
    action: params.action,
    profile: session?.profile?.label,
    pid: session?.instance?.pid,
    port: session?.instance?.port,
    chromeVersion: session?.instance?.chromeVersion,
    headless: session ? shouldRunHeadless(config) : undefined,
    tabCount: session?.tabs.size,
    tab: details.tab,
    url: config.logging.includeArgs ? details.url : undefined,
    title: config.logging.includeArgs ? details.title : undefined,
    status: details.status,
    challenge: details.challenge,
    truncated: details.truncated,
    savedPath: details.savedPath,
    params: safe,
    output,
  };
}

export function safeParams(
  params: BrowserPilotParams,
  config: BrowserPilotConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const safeKeys = [
    "action",
    "topic",
    "op",
    "target",
    "tab",
    "direction",
    "wait_until",
    "format",
    "interactive",
    "max_nodes",
    "max_chars",
    "await_promise",
    "button",
    "click_count",
    "modifiers",
    "humanize",
    "clear",
    "submit",
    "delay_ms",
    "key",
    "values",
    "amount",
    "for",
    "full_page",
    "quality",
    "inline",
    "level",
    "limit",
    "policy",
    "timeout_ms",
  ];
  for (const key of safeKeys) {
    const value = params[key as keyof BrowserPilotParams];
    if (value !== undefined) out[key] = value;
  }
  if (config.logging.includeArgs) {
    for (const key of [
      "url",
      "selector",
      "ref",
      "filter",
      "path",
      "save_path",
      "text_file",
      "script_path",
    ]) {
      const value = params[key as keyof BrowserPilotParams];
      if (value !== undefined) out[key] = value;
    }
  }
  if (params.text !== undefined) {
    if (config.logging.includeSensitiveArgs)
      out.text = params.text.slice(0, config.logging.maxOutputChars);
    else out.text = { length: params.text.length, sha256: sha256(params.text) };
  }
  if (params.text_env !== undefined) out.text_env = params.text_env;
  if (params.expression !== undefined) {
    if (config.logging.includeSensitiveArgs) {
      out.expression = params.expression.slice(0, config.logging.maxOutputChars);
    } else {
      out.expression = { length: params.expression.length, sha256: sha256(params.expression) };
    }
  }
  return out;
}

export function summarizeOutput(
  action: ActionName,
  text: string,
  config: BrowserPilotConfig,
): Record<string, unknown> | undefined {
  if (config.logging.outputs === "none") return undefined;
  const cap = config.logging.maxOutputChars;
  const base = {
    chars: text.length,
    lines: text.split("\n").length,
  };
  if (config.logging.outputs === "full") {
    return { ...base, text: text.slice(0, cap), truncated: text.length > cap };
  }
  if (config.logging.outputs === "snippet" || !TINY_ACTIONS.has(action)) {
    const half = Math.max(1, Math.floor(cap / 2));
    return {
      ...base,
      head: text.slice(0, half),
      tail: text.length > half ? text.slice(-half) : undefined,
      truncated: text.length > cap,
    };
  }
  return { ...base, text: text.slice(0, cap), truncated: text.length > cap };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
