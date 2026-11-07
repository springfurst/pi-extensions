import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PaperFormat } from "puppeteer-core";
import { detectChallenge } from "../challenge";
import { readPageContent } from "../content";
import { evaluateInFrame, evaluateInPage, formatEvalValue } from "../eval";
import { capForModel, capText, finalize, hint, pageHeader, truncationHint } from "../output";
import type { BrowserPilotSession } from "../session";
import { refSelector, snapshotPage } from "../snapshot";
import {
  appendChallenge,
  indentText,
  readInputFile,
  resolvePath,
  resolveTargetSelector,
  targetFor,
  targetLabel,
  timestamp,
} from "../tool-helpers";
import type {
  BrowserPilotConfig,
  BrowserPilotContext,
  BrowserPilotParams,
  BrowserPilotToolResult,
} from "../types";
import { BrowserPilotError } from "../types";

const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

export async function snapshotResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  if (params.ref) {
    throw new BrowserPilotError(
      "snapshot does not accept ref.",
      "Use selector to scope the snapshot, or omit it to snapshot the whole page. Refs come from snapshot itself.",
    );
  }
  const result = await snapshotPage(tab.page, {
    interactive: params.interactive ?? true,
    maxNodes: params.max_nodes ?? config.maxSnapshotNodes,
    selector: params.selector,
  });
  session.snapshotCount++;
  session.refs.clear();
  for (const { ref, frame } of result.refs) {
    const selector = refSelector(ref);
    if (selector) session.refs.set(ref, { selector, snapshot: session.snapshotCount, frame });
  }
  session.persist();
  const body =
    result.lines.length > 0
      ? result.lines.join("\n")
      : params.selector
        ? `No elements matched selector ${JSON.stringify(params.selector)}.`
        : "No matching elements found.";
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
  if (params.selector && !result.matched) {
    lines.push("", hint("the selector matched nothing in the page or its frames."));
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

export async function readResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  const format =
    params.format === "text" || params.format === "html" || params.format === "outline"
      ? params.format
      : "markdown";
  const target = params.ref ? targetFor(session, tab, params) : session.activeFrame(tab);
  const selector = params.ref || params.selector ? resolveTargetSelector(params) : undefined;
  const content = await readPageContent(target, { format, selector });
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

export async function evalResult(
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
  const frame = session.activeFrame(tab);
  const result =
    frame === tab.page.mainFrame()
      ? await evaluateInPage(tab.page, {
          source,
          awaitPromise: params.await_promise ?? true,
          timeoutMs,
        })
      : await evaluateInFrame(frame, {
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

export async function screenshotResult(
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
  let annotated = 0;
  if (params.annotate) {
    annotated = await tab.page.evaluate(annotateRefs).catch(() => 0);
  }
  try {
    if (params.ref || params.selector) {
      const target = params.ref ? targetFor(session, tab, params) : session.activeFrame(tab);
      const selector = resolveTargetSelector(params);
      let handle;
      try {
        handle = await target.locator(selector).waitHandle();
      } catch {
        throw new BrowserPilotError(
          `No element matched ${targetLabel(params)}.`,
          'Run {action:"snapshot"} to find a stable ref, or check the selector.',
        );
      }
      try {
        await handle.screenshot({ path, type: format, quality });
      } finally {
        await handle.dispose().catch(() => undefined);
      }
    } else {
      await tab.page.screenshot({
        path,
        type: format,
        quality,
        fullPage: params.full_page ?? false,
      });
    }
  } finally {
    if (params.annotate) await tab.page.evaluate(removeAnnotations).catch(() => undefined);
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
    params.annotate ? `Annotated ${annotated} ref(s).` : undefined,
  ]
    .filter((line): line is string => !!line)
    .join("\n");
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
      annotated,
    },
  };
}

export function annotateRefs(): number {
  document.getElementById("__pi_annotations")?.remove();
  const root = document.createElement("div");
  root.id = "__pi_annotations";
  root.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2147483647";
  const refs: Element[] = [];
  const seen = new Set<Element>();
  const walk = (root: ParentNode) => {
    for (const element of Array.from(root.querySelectorAll("[data-pi-ref]"))) {
      if (seen.has(element)) continue;
      seen.add(element);
      refs.push(element);
    }
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(document);
  for (const element of refs) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const box = document.createElement("div");
    box.style.cssText = `position:absolute;left:${rect.left + window.scrollX}px;top:${rect.top + window.scrollY}px;width:${rect.width}px;height:${rect.height}px;border:2px solid #ff5c5c;box-sizing:border-box`;
    const label = document.createElement("span");
    label.textContent = element.getAttribute("data-pi-ref") ?? "";
    label.style.cssText =
      "position:absolute;left:0;top:-16px;background:#ff5c5c;color:#fff;font:11px monospace;padding:1px 3px";
    box.appendChild(label);
    root.appendChild(box);
  }
  document.body.appendChild(root);
  return refs.length;
}

export function removeAnnotations(): void {
  document.getElementById("__pi_annotations")?.remove();
}

export async function consoleResult(
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
  const groups = new Map<string, { entry: (typeof entries)[number]; count: number }>();
  for (const entry of entries) {
    const key = [entry.level, entry.text, entry.url ?? "", entry.line ?? ""].join("\u0000");
    const existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, { entry, count: 1 });
  }
  const body =
    groups.size > 0
      ? [...groups.values()]
          .map(({ entry, count }) => {
            const location = entry.url
              ? ` (${entry.url}${entry.line !== undefined ? `:${entry.line}` : ""})`
              : "";
            const suffix = count > 1 ? ` ×${count}` : "";
            const line = `[${entry.level}] ${entry.text}${location}${suffix}`;
            return params.detail && entry.stack ? `${line}\n${indentText(entry.stack)}` : line;
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

export async function pdfResult(
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

export async function harResult(
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

export async function traceResult(
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
