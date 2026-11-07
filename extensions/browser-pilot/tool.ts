import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ElementHandle, Frame, KeyInput, Page, PaperFormat } from "puppeteer-core";
import {
  USAGE_SCHEMA_VERSION,
  createFileUsageLogger,
  expandTilde,
  type UsageRecord,
} from "../../lib/logging";
import { PI_VERSION, TOOL_VERSION } from "../../lib/version";
import { ACTION_NAMES, renderHelp, validateAction, type ActionName } from "./actions";
import { detectChallenge, waitForHuman } from "./challenge";
import { loadBrowserPilotConfig } from "./config";
import { readPageContent } from "./content";
import { evaluateInPage, formatEvalValue } from "./eval";
import {
  instanceRecordPath,
  pidAlive,
  probeInstance,
  readInstanceRecord,
  shouldRunHeadless,
} from "./launcher";
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
  "connect",
  "upload",
  "download",
  "cookies",
  "storage",
  "emulate",
  "pdf",
  "har",
  "trace",
  "route",
  "expect",
  "steps",
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
    const hintText =
      error instanceof BrowserPilotError
        ? error.hint
        : /timeout/i.test(message)
          ? "Increase timeout_ms, or inspect the page with status."
          : undefined;
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
    session?.touch();
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
    case "connect":
      return connectResult(params, session);
    case "upload":
      return uploadResult(params, session, config, ctx);
    case "download":
      return downloadResult(params, session, ctx);
    case "cookies":
      return cookiesResult(params, session);
    case "storage":
      return storageResult(params, session);
    case "emulate":
      return emulateResult(params, session);
    case "pdf":
      return pdfResult(params, session, config, ctx);
    case "har":
      return harResult(params, session, config, ctx);
    case "trace":
      return traceResult(params, session, config, ctx);
    case "route":
      return routeResult(params, session, config);
    case "expect":
      return expectResult(params, session, config, ctx);
    case "steps":
      return stepsResult(params, session, config, ctx);
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
    const lines = [
      "Browser: not running",
      `Profile: ${profile.label} (${profile.userDataDir}) ${profile.persistent ? "[persistent]" : "[isolated]"}`,
      `Mode: ${mode}`,
      "Tabs: 0",
    ];
    const record = readInstanceRecord(instanceRecordPath(session.agentDir, profile.key));
    if (record && pidAlive(record.pid)) {
      const probe = await probeInstance(record.port).catch(() => undefined);
      if (probe) {
        const owner = record.ownerSessionId ? `, session ${record.ownerSessionId}` : "";
        lines.push(`Profile owner: pid ${record.pid}, port ${record.port}${owner}`);
        lines.push(
          hint('this profile is already in use; use profile:"session" or a named profile.'),
        );
      }
    }
    lines.push("", hint('call {action:"open"} to start Chrome.'));
    const text = lines.join("\n");
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
    `External: ${session.instance.external ? "yes" : "no"}`,
    formatTabs(tabs, config.maxTabs),
  ];
  if (challenge) lines.push(`Challenge: ${formatChallenge(challenge)}`);
  if (session.pendingDialog) {
    lines.push(`Dialog: ${session.pendingDialog.type} "${session.pendingDialog.message}"`);
  }
  if (!session.browser?.connected) {
    lines.push("", hint("the next action will try to reconnect."));
  } else if (challenge?.severity === "blocking") {
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
      external: session.instance.external ?? false,
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
  appendChallenge(lines, nav.challenge);
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
  for (const { ref, frame } of result.refs) {
    const selector = refSelector(ref);
    if (selector) session.refs.set(ref, { selector, snapshot: session.snapshotCount, frame });
  }
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
  appendChallenge(lines, challenge);
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
  appendChallenge(lines, challenge);
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

async function typeResult(
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

async function pressResult(
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
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  const locator = locatorFor(session, tab, params, timeout)
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

async function hoverResult(
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
      onProgress: (elapsed, challenge) => {
        if (Date.now() - lastUpdate < 5_000) return;
        lastUpdate = Date.now();
        if (challenge) session.challenge = challenge;
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
            challenge: challenge ?? session.challenge,
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
  appendChallenge(lines, challenge);
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
  const screenshotDir = config.screenshotsDir
    ? resolvePath(session.cwd, config.screenshotsDir)
    : join(session.agentDir, "browser-pilot", "screenshots");
  const path =
    params.path !== undefined
      ? resolvePath(session.cwd, params.path)
      : join(screenshotDir, `${timestamp()}-tab${tab.handle}.${format}`);
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

async function connectResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const instance = await session.connectExternal(params.endpoint!);
  const infos = await session.listTabs();
  const current = infos.find((info) => info.current);
  const lines = [
    `Attached to ${instance.wsEndpoint}`,
    formatTabs(infos, session.config.maxTabs),
    "",
    hint("this browser is external; close disconnects without closing Chrome."),
  ];
  return finalize(lines.join("\n"), {
    action: "connect",
    tab: current?.handle,
    url: current?.url,
    title: current?.title,
    tabs: infos,
    endpoint: instance.wsEndpoint,
    external: true,
  });
}

async function uploadResult(
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

async function downloadResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  if (params.op === "clear") {
    const count = session.clearDownloads();
    return finalize(`Cleared ${count} download record(s).`, {
      action: "download",
      op: "clear",
      tab: tab.handle,
      count,
    });
  }
  if (params.op === "wait") {
    const timeout = params.timeout_ms ?? session.config.actionTimeoutSeconds * 1000;
    const download = await session.waitForDownload(timeout, params.filter, ctx.signal);
    return finalize(
      [
        pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
        `Download ${download.state}: ${download.path}`,
        `${download.suggestedFilename} · ${download.receivedBytes}/${download.totalBytes} bytes`,
      ].join("\n"),
      {
        action: "download",
        op: "wait",
        tab: tab.handle,
        url: tab.page.url(),
        download,
        savedPath: download.path,
      },
    );
  }
  const limit = params.limit ?? 100;
  const downloads = session.listDownloads(params.filter).slice(-limit);
  const body =
    downloads.length > 0
      ? downloads
          .map(
            (download) =>
              `[${download.state}] ${download.suggestedFilename} · ${download.receivedBytes}/${download.totalBytes} bytes · ${download.path}`,
          )
          .join("\n")
      : "No downloads recorded.";
  return finalize(
    [pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")), "", body].join(
      "\n",
    ),
    {
      action: "download",
      op: "list",
      tab: tab.handle,
      url: tab.page.url(),
      count: downloads.length,
      downloads,
    },
  );
}

async function cookiesResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const browser = session.browser!;
  const op = String(params.op);
  if (op === "list") {
    const cookies = params.url ? await tab.page.cookies(params.url) : await browser.cookies();
    const body =
      cookies.length > 0
        ? cookies
            .map(
              (cookie) =>
                `${cookie.name}=${cookie.value} · domain=${cookie.domain} path=${cookie.path}` +
                ` · expires=${cookie.expires} secure=${cookie.secure} httpOnly=${cookie.httpOnly}` +
                (cookie.sameSite ? ` sameSite=${cookie.sameSite}` : ""),
            )
            .join("\n")
        : "No cookies.";
    return finalize(
      [
        pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
        "",
        body,
      ].join("\n"),
      {
        action: "cookies",
        op,
        tab: tab.handle,
        url: tab.page.url(),
        count: cookies.length,
        cookies,
      },
    );
  }
  if (op === "set") {
    const cookie = {
      name: params.name!,
      value: params.value!,
      domain: params.domain,
      path: params.cookie_path ?? "/",
      expires: params.expires,
      httpOnly: params.http_only,
      secure: params.secure,
      sameSite: params.same_site,
      url: params.url,
    };
    if (params.url) await tab.page.setCookie(cookie);
    else await browser.setCookie({ ...cookie, domain: params.domain! });
    return finalize(`Set cookie ${params.name}.`, {
      action: "cookies",
      op,
      tab: tab.handle,
      url: tab.page.url(),
      name: params.name,
    });
  }
  if (op === "delete") {
    const request = {
      name: params.name!,
      url: params.url,
      domain: params.domain,
      path: params.cookie_path,
    };
    await browser.deleteMatchingCookies(request);
    return finalize(`Deleted cookie ${params.name}.`, {
      action: "cookies",
      op,
      tab: tab.handle,
      url: tab.page.url(),
      name: params.name,
    });
  }
  const cookies = await browser.cookies();
  for (const cookie of cookies) {
    await browser.deleteCookie(cookie);
  }
  return finalize(`Cleared ${cookies.length} cookie(s).`, {
    action: "cookies",
    op: "clear",
    tab: tab.handle,
    url: tab.page.url(),
    count: cookies.length,
  });
}

async function storageResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const area = params.area === "session" ? "sessionStorage" : "localStorage";
  const result = await tab.page.evaluate(
    ({ areaName, op, key, value }) => {
      const storage = window[areaName as "localStorage" | "sessionStorage"];
      if (op === "keys") return Object.keys(storage);
      if (op === "get") return key === undefined ? null : storage.getItem(key);
      if (op === "set") {
        storage.setItem(key ?? "", value ?? "");
        return true;
      }
      if (op === "remove") {
        storage.removeItem(key ?? "");
        return true;
      }
      storage.clear();
      return true;
    },
    { areaName: area, op: params.op, key: params.key, value: params.value },
  );
  const text =
    params.op === "get"
      ? result === null
        ? `${params.key} is not set in ${area}.`
        : String(result)
      : params.op === "keys"
        ? Array.isArray(result) && result.length > 0
          ? result.join("\n")
          : `No keys in ${area}.`
        : `${params.op} ${area}${params.key ? ` key ${params.key}` : ""}.`;
  return finalize(
    [pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")), text].join(
      "\n",
    ),
    {
      action: "storage",
      op: params.op,
      tab: tab.handle,
      url: tab.page.url(),
      area,
      key: params.key,
      value: result,
    },
  );
}

async function emulateResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const state = params.reset ? {} : { ...session.emulation };
  if (params.reset) {
    state.network = null;
    state.geolocation = null;
    state.cpuThrottle = 1;
    state.colorScheme = "no-preference";
    state.reducedMotion = "no-preference";
  }
  if (params.width !== undefined || params.height !== undefined) {
    const current = state.viewport ?? {
      width: session.config.viewport.width,
      height: session.config.viewport.height,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    };
    state.viewport = {
      ...current,
      width: params.width ?? current.width,
      height: params.height ?? current.height,
      deviceScaleFactor: params.device_scale_factor ?? current.deviceScaleFactor,
      isMobile: params.is_mobile ?? current.isMobile,
      hasTouch: params.has_touch ?? current.hasTouch,
    };
  } else if (
    params.device_scale_factor !== undefined ||
    params.is_mobile !== undefined ||
    params.has_touch !== undefined
  ) {
    const current = state.viewport ?? {
      width: session.config.viewport.width,
      height: session.config.viewport.height,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    };
    state.viewport = {
      ...current,
      deviceScaleFactor: params.device_scale_factor ?? current.deviceScaleFactor,
      isMobile: params.is_mobile ?? current.isMobile,
      hasTouch: params.has_touch ?? current.hasTouch,
    };
  }
  if (params.user_agent !== undefined) state.userAgent = params.user_agent;
  if (params.locale !== undefined) state.locale = params.locale;
  if (params.timezone !== undefined) state.timezone = params.timezone;
  if (params.color_scheme !== undefined) state.colorScheme = params.color_scheme;
  if (params.reduced_motion !== undefined) state.reducedMotion = params.reduced_motion;
  if (params.cpu_throttle !== undefined) state.cpuThrottle = params.cpu_throttle;
  if (params.network_profile) {
    const profile = session.networkProfile(params.network_profile);
    state.network = {
      offline: params.network_profile === "offline",
      latency: params.latency ?? profile.latency,
      download: params.download_throughput ?? profile.download,
      upload: params.upload_throughput ?? profile.upload,
    };
  } else if (
    params.latency !== undefined ||
    params.download_throughput !== undefined ||
    params.upload_throughput !== undefined
  ) {
    const current = state.network ?? { offline: false, latency: 0, download: 0, upload: 0 };
    state.network = {
      offline: current.offline ?? false,
      latency: params.latency ?? current.latency,
      download: params.download_throughput ?? current.download,
      upload: params.upload_throughput ?? current.upload,
    };
  }
  if (params.latitude !== undefined || params.longitude !== undefined) {
    state.geolocation = {
      latitude: params.latitude ?? 0,
      longitude: params.longitude ?? 0,
      accuracy: params.accuracy,
    };
  }
  const info = await session.setEmulation(params.tab, state);
  return finalize(
    [pageHeader(info.handle, info.url, info.title), `Emulation: ${describeEmulation(state)}`].join(
      "\n",
    ),
    {
      action: "emulate",
      tab: info.handle,
      url: info.url,
      title: info.title,
      emulation: state,
    },
  );
}

function describeEmulation(state: BrowserPilotSession["emulation"]): string {
  const parts: string[] = [];
  if (state.viewport) {
    parts.push(
      `viewport ${state.viewport.width}×${state.viewport.height}` +
        (state.viewport.isMobile ? " mobile" : "") +
        (state.viewport.hasTouch ? " touch" : ""),
    );
  }
  if (state.userAgent) parts.push("user-agent");
  if (state.locale) parts.push(`locale ${state.locale}`);
  if (state.timezone) parts.push(`timezone ${state.timezone}`);
  if (state.colorScheme) parts.push(`color-scheme ${state.colorScheme}`);
  if (state.reducedMotion) parts.push(`reduced-motion ${state.reducedMotion}`);
  if (state.network) {
    parts.push(
      state.network.offline
        ? "offline"
        : `network ${state.network.download}/${state.network.upload} B/s, ${state.network.latency}ms`,
    );
  }
  if (state.cpuThrottle && state.cpuThrottle !== 1) parts.push(`cpu ×${state.cpuThrottle}`);
  if (state.geolocation) parts.push("geolocation");
  return parts.length > 0 ? parts.join(" · ") : "defaults";
}

async function pdfResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  _config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const path =
    params.path !== undefined
      ? resolvePath(ctx.cwd, params.path)
      : join(session.exportsDir(), `${timestamp()}-tab${tab.handle}.pdf`);
  mkdirSync(dirname(path), { recursive: true });
  const margin = params.margin;
  const buffer = await tab.page.pdf({
    path,
    format: params.paper_format as PaperFormat | undefined,
    landscape: params.landscape,
    printBackground: params.print_background,
    scale: params.scale,
    pageRanges: params.page_ranges,
    margin: margin ? { top: margin, right: margin, bottom: margin, left: margin } : undefined,
  });
  const bytes = statSync(path).size;
  return finalize(
    [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      `PDF: ${path}`,
      `Bytes: ${bytes} · generated: ${buffer.length}`,
    ].join("\n"),
    {
      action: "pdf",
      tab: tab.handle,
      url: tab.page.url(),
      title: await tab.page.title().catch(() => ""),
      savedPath: path,
      bytes,
    },
  );
}

async function harResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  _config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  if (params.op === "start") {
    session.startHar();
    return finalize(
      [
        pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
        "HAR recording started.",
      ].join("\n"),
      { action: "har", op: "start", tab: tab.handle, url: tab.page.url() },
    );
  }
  if (params.op === "clear") {
    const count = session.clearHar();
    return finalize(`Cleared ${count} HAR network entries.`, {
      action: "har",
      op: "clear",
      tab: tab.handle,
      count,
    });
  }
  const { har, entries } = await session.stopHar();
  const path =
    params.path !== undefined
      ? resolvePath(ctx.cwd, params.path)
      : join(session.exportsDir(), `${timestamp()}-tab${tab.handle}.har`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(har, null, 2)}\n`, "utf-8");
  const bytes = statSync(path).size;
  return finalize(
    [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      `HAR: ${path}`,
      `Entries: ${entries} · bytes: ${bytes}`,
    ].join("\n"),
    {
      action: "har",
      op: "stop",
      tab: tab.handle,
      url: tab.page.url(),
      entries,
      savedPath: path,
      bytes,
    },
  );
}

async function traceResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  _config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  if (params.op === "start") {
    const info = await session.startTrace(params.tab);
    return finalize(`Trace started on tab ${info.handle}.`, {
      action: "trace",
      op: "start",
      tab: info.handle,
      url: info.url,
    });
  }
  const result = await session.stopTrace();
  const path =
    params.path !== undefined
      ? resolvePath(ctx.cwd, params.path)
      : join(session.exportsDir(), `${timestamp()}-trace.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result.trace, null, 2)}\n`, "utf-8");
  const bytes = statSync(path).size;
  return finalize([`Trace: ${path}`, `Events: ${result.events} · bytes: ${bytes}`].join("\n"), {
    action: "trace",
    op: "stop",
    tab: result.tab,
    events: result.events,
    savedPath: path,
    bytes,
  });
}

async function routeResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  _config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  if (params.op === "list") {
    const body =
      session.routeRules.length > 0
        ? session.routeRules
            .map(
              (rule) =>
                `${rule.id} ${rule.action} ${rule.urlPattern}` +
                (rule.resourceType ? ` (${rule.resourceType})` : "") +
                (rule.status ? ` status=${rule.status}` : "") +
                (rule.delayMs ? ` delay=${rule.delayMs}ms` : ""),
            )
            .join("\n")
        : "No route rules.";
    return finalize(body, {
      action: "route",
      op: "list",
      count: session.routeRules.length,
      rules: session.routeRules,
    });
  }
  if (params.op === "clear") {
    const count = await session.clearRouteRules();
    return finalize(`Cleared ${count} route rule(s).`, {
      action: "route",
      op: "clear",
      count,
    });
  }
  if (params.op === "remove") {
    const removed = await session.removeRouteRule(params.id!);
    if (!removed) {
      throw new BrowserPilotError(
        `No route rule with id ${params.id}.`,
        'Run {action:"route", op:"list"} to see rule ids.',
      );
    }
    return finalize(`Removed route rule ${params.id}.`, {
      action: "route",
      op: "remove",
      id: params.id,
    });
  }
  await session.ensure();
  const rule = await session.addRouteRule({
    urlPattern: params.url_pattern ?? "*",
    resourceType: params.resource_type,
    action: params.route_action!,
    status: params.status,
    body: params.body,
    contentType: params.content_type,
    headers: params.headers,
    delayMs: params.delay_ms,
  });
  return finalize(`Added route rule ${rule.id}: ${rule.action} ${rule.urlPattern}`, {
    action: "route",
    op: "add",
    rule,
  });
}

async function expectResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const timeout = params.timeout_ms ?? config.actionTimeoutSeconds * 1000;
  const operator =
    params.operator ??
    (params.check === "text" || params.check === "title" ? "contains" : "equals");
  const expected =
    params.expected ??
    (params.check === "selector" || params.check === "visible" || params.check === "hidden"
      ? "true"
      : "");
  const started = Date.now();
  let actual = "";
  let passed = false;
  while (true) {
    actual = await readExpectationValue(params, session, tab);
    passed = compareExpectation(actual, expected, operator);
    if (passed || Date.now() - started >= timeout) break;
    await sleep(100);
    ctx.signal?.throwIfAborted();
  }
  if (!passed) {
    throw new BrowserPilotError(
      `expect ${params.check} failed: expected ${operator} ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`,
      "Inspect the page with snapshot or read, then retry with a longer timeout_ms if the page is still loading.",
    );
  }
  return finalize(
    [
      pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => "")),
      `expect ${params.check}: ${operator} ${JSON.stringify(expected)} passed.`,
      `Actual: ${JSON.stringify(actual)}`,
    ].join("\n"),
    {
      action: "expect",
      tab: tab.handle,
      url: tab.page.url(),
      title: await tab.page.title().catch(() => ""),
      check: params.check,
      operator,
      expected,
      actual,
      elapsedMs: Date.now() - started,
    },
  );
}

async function readExpectationValue(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  tab: Awaited<ReturnType<BrowserPilotSession["ensureTab"]>>,
): Promise<string> {
  if (params.check === "text") {
    return tab.page.evaluate(() => document.body?.innerText ?? "");
  }
  if (params.check === "url") return tab.page.url();
  if (params.check === "title") return tab.page.title();
  const target = targetFor(session, tab, params);
  const selector = resolveTargetSelector(params);
  if (params.check === "selector") {
    const found = await target.evaluate(
      (value) => document.querySelector(value) !== null,
      selector,
    );
    return String(found);
  }
  if (params.check === "count") {
    const count = await target.evaluate(
      (value) => document.querySelectorAll(value).length,
      selector,
    );
    return String(count);
  }
  if (params.check === "visible" || params.check === "hidden") {
    const handle = await target.locator(selector).waitHandle();
    const visible = await handle.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    return String(params.check === "visible" ? visible : !visible);
  }
  const handle = await target.locator(selector).waitHandle();
  if (params.check === "attribute") {
    return (
      (await handle.evaluate(
        (element, name) => element.getAttribute(name),
        params.attribute ?? "",
      )) ?? ""
    );
  }
  return handle.evaluate((element) => {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      return element.value;
    }
    return (element as HTMLElement).innerText ?? element.textContent ?? "";
  });
}

function compareExpectation(actual: string, expected: string, operator: string): boolean {
  if (operator === "contains") return actual.includes(expected);
  if (operator === "not_contains") return !actual.includes(expected);
  if (operator === "matches") {
    try {
      return new RegExp(expected).test(actual);
    } catch {
      return false;
    }
  }
  if (operator === "gt" || operator === "lt" || operator === "gte" || operator === "lte") {
    const left = Number(actual);
    const right = Number(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (operator === "gt") return left > right;
    if (operator === "lt") return left < right;
    if (operator === "gte") return left >= right;
    return left <= right;
  }
  if (operator === "not_equals") return actual !== expected;
  return actual === expected;
}

async function stepsResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const steps = params.steps ?? [];
  const results: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] as unknown as BrowserPilotParams;
    const action = step.action;
    const label = `Step ${index + 1}: ${String(action)}`;
    if (!action || !ACTION_NAMES.includes(action)) {
      const error = `Unknown step action "${String(action)}".`;
      results.push({ action, ok: false, error });
      lines.push(`${label}\n${error}`);
      if (params.stop_on_error !== false) break;
      continue;
    }
    try {
      validateAction(action, step as unknown as Record<string, unknown>);
      let result: BrowserPilotToolResult;
      if (action === "help") {
        result = finalize(renderHelp(step.topic), { action: "help" });
      } else if (action === "status") {
        const status = await statusResult(session, config);
        result = finalize(status.text, status.details);
      } else {
        result = await dispatch(step, session, config, ctx);
      }
      const stepText = result.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      results.push({ action, ok: !result.isError, text: stepText, details: result.details });
      lines.push(`${label}\n${stepText}`);
      if (result.isError && params.stop_on_error !== false) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ action, ok: false, error: message });
      lines.push(`${label}\n${message}`);
      if (params.stop_on_error !== false) break;
    }
  }
  return finalize(lines.join("\n\n"), { action: "steps", steps: results });
}

function targetFor(
  session: BrowserPilotSession,
  tab: Awaited<ReturnType<BrowserPilotSession["ensureTab"]>>,
  params: BrowserPilotParams,
): Page | Frame {
  if (!params.ref) return tab.page;
  const entry = session.refs.get(params.ref);
  if (!entry) {
    throw new BrowserPilotError(
      `Ref ${params.ref} is not known in this snapshot.`,
      'Run {action:"snapshot"} to get fresh refs.',
    );
  }
  if (entry.frame?.isDetached()) {
    throw new BrowserPilotError(
      `The frame for ref ${params.ref} is detached.`,
      'Run {action:"snapshot"} again to get refs in the current page.',
    );
  }
  return entry.frame ?? tab.page;
}

function locatorFor(
  session: BrowserPilotSession,
  tab: Awaited<ReturnType<BrowserPilotSession["ensureTab"]>>,
  params: BrowserPilotParams,
  timeout: number,
) {
  const selector = resolveTargetSelector(params);
  return targetFor(session, tab, params).locator(selector).setTimeout(timeout);
}

function appendChallenge(lines: string[], challenge: ChallengeInfo | undefined): void {
  if (!challenge) return;
  lines.push("", formatChallenge(challenge)!);
  if (challenge.severity === "blocking") {
    lines.push(hint('solve it in the Chrome window, then run {action:"wait", for:"human"}.'));
  }
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
  try {
    const size = statSync(absolute).size;
    if (size > MAX_INPUT_FILE_BYTES) {
      throw new BrowserPilotError(
        `Input file is ${size} bytes, above the ${MAX_INPUT_FILE_BYTES} byte cap.`,
        "Pass a smaller file or use an inline expression.",
      );
    }
    return readFileSync(absolute, "utf-8");
  } catch (error) {
    if (error instanceof BrowserPilotError) throw error;
    throw new BrowserPilotError(
      `Could not read ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      "Check that the file exists and is readable.",
    );
  }
}

function resolvePath(cwd: string, path: string): string {
  const expanded = expandTilde(path);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
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
    "area",
    "domain",
    "cookie_path",
    "expires",
    "http_only",
    "secure",
    "same_site",
    "width",
    "height",
    "device_scale_factor",
    "is_mobile",
    "has_touch",
    "user_agent",
    "locale",
    "timezone",
    "color_scheme",
    "reduced_motion",
    "network_profile",
    "latency",
    "download_throughput",
    "upload_throughput",
    "cpu_throttle",
    "latitude",
    "longitude",
    "accuracy",
    "reset",
    "paper_format",
    "landscape",
    "print_background",
    "scale",
    "page_ranges",
    "margin",
    "url_pattern",
    "resource_type",
    "route_action",
    "status",
    "content_type",
    "id",
    "name",
    "check",
    "operator",
    "expected",
    "attribute",
    "stop_on_error",
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
      "endpoint",
      "files",
      "headers",
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
  for (const key of ["value", "body"] as const) {
    const value = params[key];
    if (value === undefined) continue;
    if (config.logging.includeSensitiveArgs) {
      out[key] = value.slice(0, config.logging.maxOutputChars);
    } else {
      out[key] = { length: value.length, sha256: sha256(value) };
    }
  }
  if (params.steps !== undefined) {
    out.steps = params.steps.map((step) =>
      safeParams(step as unknown as BrowserPilotParams, config),
    );
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
