import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";
import { Container, Markdown, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { previewText, shortenUrl } from "./output";
import type { BrowserPilotCall, BrowserPilotDetails } from "./types";

interface RenderResultLike {
  details?: unknown;
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface RenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

/** The subset of pi's render context this renderer uses. */
export interface PilotRenderContext {
  args?: BrowserPilotCall;
  expanded?: boolean;
  state?: Record<string, unknown>;
  keyHint?: (keybinding: string, description: string) => string;
}

const COLLAPSED_ARG_CHARS = 140;
const COLLAPSED_VALUE_CHARS = 48;
const COLLAPSED_SUMMARY_CHARS = 160;
const RESULT_URL_CHARS = 96;

const PAGE_HEADER = /^Tab \d+ · /;
const KEY_VALUE = /^([A-Z][^:]{0,60}): (.*)$/;
const STEP_HEADER = /^(Step \d+: )(\S+)$/;

/** Arguments that identify a call, in the order they are most useful to read. */
const ARG_ORDER = [
  "operation",
  "check",
  "until",
  "target",
  "direction",
  "ref",
  "selector",
  "url",
  "key",
  "path",
  "name",
  "request_id",
  "rule_id",
  "expression",
  "script_path",
  "text",
  "text_env",
  "text_file",
  "format",
  "tab",
  "frame",
  "group",
  "action",
];

const BARE_STRING_KEYS = new Set([
  "operation",
  "check",
  "until",
  "target",
  "direction",
  "ref",
  "key",
  "format",
  "tab",
  "frame",
  "group",
  "action",
  "level",
  "policy",
  "request_id",
  "rule_id",
]);

const INPUT_PREVIEW_ACTIONS = new Set(["eval", "type", "press", "upload", "wait"]);

const FOOTER_PREFIXES = [
  "[Output truncated",
  "[Snapshot truncated",
  "[Step output truncated",
  "[Saved to",
  "Hint:",
  "Suggested next:",
  "Reminder:",
  "Challenge:",
  "Current:",
];

function firstText(result: RenderResultLike): string {
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

/** Split a result body into its page header and the action-specific lines. */
function bodyLines(body: string): { header: string; content: string[] } {
  const lines = body.split("\n");
  if (lines.length > 0 && PAGE_HEADER.test(lines[0])) {
    return { header: lines[0], content: lines.slice(1) };
  }
  return { header: "", content: lines };
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start])) start++;
  while (end > start && isBlank(lines[end - 1])) end--;
  return lines.slice(start, end);
}

function isFooter(line: string): boolean {
  return FOOTER_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/** Separate the page content from trailing notices such as hints and truncation. */
function splitResultBody(action: string, content: string[]): { body: string[]; footers: string[] } {
  let lines = content;
  if (action === "read" || action === "eval") {
    let index = 0;
    if (lines[index] !== undefined && /^(Format|Result): /.test(lines[index])) {
      index++;
      if (lines[index] !== undefined && isBlank(lines[index])) index++;
    }
    lines = lines.slice(index);
  }
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (isBlank(line) || isFooter(line)) end--;
    else break;
  }
  return {
    body: trimBlankEdges(lines.slice(0, end)),
    footers: lines.slice(end).filter((line) => !isBlank(line)),
  };
}

function argumentEntries(call: BrowserPilotCall): Array<[string, unknown]> {
  const params = call.params ?? {};
  const order = new Map(ARG_ORDER.map((key, index) => [key, index]));
  return Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => {
      const leftOrder = order.get(left) ?? ARG_ORDER.length;
      const rightOrder = order.get(right) ?? ARG_ORDER.length;
      return leftOrder === rightOrder ? left.localeCompare(right) : leftOrder - rightOrder;
    });
}

function collapsedValue(key: string, value: unknown): string {
  if (typeof value === "string") {
    if (key === "text_env") return `$${value}`;
    if (key === "url" || key === "endpoint") return shortenUrl(value, COLLAPSED_VALUE_CHARS);
    if (key === "text_file" || key === "script_path" || key === "path" || key === "save_path") {
      return previewText(value, COLLAPSED_VALUE_CHARS);
    }
    const text = previewText(value, COLLAPSED_VALUE_CHARS);
    return BARE_STRING_KEYS.has(key) ? text : JSON.stringify(text);
  }
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, 4).map((item) => collapsedValue(key, item));
    return `[${items.join(", ")}${value.length > 4 ? ", …" : ""}]`;
  }
  if (typeof value === "object") {
    try {
      return previewText(JSON.stringify(value), COLLAPSED_VALUE_CHARS);
    } catch {
      return "{…}";
    }
  }
  return String(value);
}

function collapsedArgs(call: BrowserPilotCall): string | undefined {
  const parts = argumentEntries(call).map(([key, value]) => `${key}=${collapsedValue(key, value)}`);
  if (parts.length === 0) return undefined;
  return previewText(parts.join(" · "), COLLAPSED_ARG_CHARS);
}

function expandedValue(key: string, value: unknown, theme: Theme): string[] {
  if (typeof value === "string") {
    if (key === "text_env") return [`$${value}`];
    if (key === "expression") return highlightCode(value, "javascript");
    if (value.includes("\n")) {
      return value.split("\n").map((line) => theme.fg("toolOutput", line));
    }
    return [theme.fg("toolOutput", value)];
  }
  if (value === null) return [theme.fg("toolOutput", "null")];
  if (typeof value === "number" || typeof value === "boolean") {
    return [theme.fg("toolOutput", String(value))];
  }
  try {
    return highlightCode(JSON.stringify(value, null, 2), "json");
  } catch {
    return [theme.fg("dim", String(value))];
  }
}

function expandedArgs(call: BrowserPilotCall, theme: Theme): string {
  const entries = argumentEntries(call);
  const lines = [theme.fg("muted", theme.bold("Arguments"))];
  if (entries.length === 0) {
    lines.push(theme.fg("dim", "  (none)"));
    return lines.join("\n");
  }
  for (const [key, value] of entries) {
    const rendered = expandedValue(key, value, theme);
    if (rendered.length === 1 && !rendered[0].includes("\n")) {
      lines.push(`  ${theme.fg("muted", key)}${theme.fg("dim", ":")} ${rendered[0]}`);
    } else {
      lines.push(`  ${theme.fg("muted", key)}${theme.fg("dim", ":")}`);
      for (const line of rendered) lines.push(`    ${line}`);
    }
  }
  return lines.join("\n");
}

function callHeader(call: BrowserPilotCall, theme: Theme, includeArgs: boolean): string {
  let text = theme.fg("toolTitle", theme.bold("browser-pilot "));
  text += theme.fg("accent", call.action);
  if (includeArgs) {
    const args = collapsedArgs(call);
    if (args !== undefined) text += theme.fg("muted", ` · ${args}`);
  }
  return text;
}

export function renderPilotCall(
  call: BrowserPilotCall,
  theme: Theme,
  context?: PilotRenderContext,
): Component {
  const expanded = context?.expanded === true;
  if (context?.state) context.state.argsExpanded = expanded;
  if (!expanded) return new TruncatedText(callHeader(call, theme, true), 0, 0);

  const container = new Container();
  container.addChild(new Text(callHeader(call, theme, false), 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(expandedArgs(call, theme), 0, 0));
  return container;
}

function markdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    underline: (text) => theme.underline(text),
    strikethrough: (text) => theme.strikethrough(text),
    highlightCode: (code, lang) => highlightCode(code, lang),
  };
}

function highlightedText(text: string, language: string): Text {
  return new Text(highlightCode(text, language).join("\n"), 0, 0);
}

function evalOutputLanguage(details: BrowserPilotDetails, text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (details.resultType === "object") return "json";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Not JSON; fall through.
    }
  }
  if (details.resultType === "string" && /^<[a-z!]/i.test(trimmed)) return "html";
  return undefined;
}

function noticeLine(line: string, theme: Theme): string | undefined {
  if (/^\[.*truncated/i.test(line)) return theme.fg("warning", line);
  if (line.startsWith("[Saved to")) return theme.fg("success", line);
  if (line.startsWith("Challenge:")) return theme.fg("warning", line);
  if (
    line.startsWith("Hint:") ||
    line.startsWith("Suggested next:") ||
    line.startsWith("Reminder:") ||
    line.startsWith("Current:")
  ) {
    return theme.fg("muted", line);
  }
  return undefined;
}

function styleSnapshotLine(line: string, theme: Theme): string {
  const notice = noticeLine(line, theme);
  if (notice !== undefined) return notice;
  if (line.startsWith("Frame: ")) {
    return theme.fg("accent", "Frame:") + theme.fg("muted", line.slice(6));
  }
  const match = /^(\[e\d+\])\s+(\S+)(.*)$/.exec(line);
  if (!match) return theme.fg("toolOutput", line);
  return (
    theme.fg("accent", match[1]) +
    " " +
    theme.fg("muted", match[2]) +
    theme.fg("toolOutput", match[3])
  );
}

function styleNetworkLine(line: string, theme: Theme): string {
  const notice = noticeLine(line, theme);
  if (notice !== undefined) return notice;
  if (line.startsWith("Network: ")) {
    return theme.fg("accent", "Network:") + theme.fg("toolOutput", line.slice(8));
  }
  if (/^(Request headers|Response headers|Body):$/.test(line)) {
    return theme.fg("muted", theme.bold(line));
  }
  const request = /^(r\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
  if (request) {
    const [, id, status, method, rest] = request;
    const statusText = /^2\d\d$/.test(status)
      ? theme.fg("success", status)
      : /^3\d\d$/.test(status)
        ? theme.fg("warning", status)
        : /^(4\d\d|5\d\d|FAIL)$/.test(status)
          ? theme.fg("error", status)
          : theme.fg("dim", status);
    return (
      theme.fg("muted", id) +
      " " +
      statusText +
      " " +
      theme.fg("toolTitle", theme.bold(method)) +
      " " +
      theme.fg("toolOutput", rest)
    );
  }
  const keyValue = /^([^:]+): (.*)$/.exec(line);
  if (keyValue) {
    return (
      theme.fg("muted", keyValue[1]) +
      theme.fg("dim", ":") +
      " " +
      theme.fg("toolOutput", keyValue[2])
    );
  }
  return theme.fg("toolOutput", line);
}

function styleConsoleLine(line: string, theme: Theme): string {
  const notice = noticeLine(line, theme);
  if (notice !== undefined) return notice;
  if (/^\s{2,}/.test(line)) return theme.fg("dim", line);
  const match = /^\[([^\]]+)\] (.*)$/.exec(line);
  if (!match) return theme.fg("toolOutput", line);
  const level = match[1].toLowerCase();
  const color =
    level === "error"
      ? "error"
      : level === "warn" || level === "warning"
        ? "warning"
        : level === "debug" || level === "verbose"
          ? "dim"
          : "accent";
  return `${theme.fg(color, `[${match[1]}]`)} ${theme.fg("toolOutput", match[2])}`;
}

function styleStepLine(line: string, theme: Theme): string {
  const notice = noticeLine(line, theme);
  if (notice !== undefined) return notice;
  const step = STEP_HEADER.exec(line);
  if (step) return theme.fg("muted", step[1]) + theme.fg("accent", step[2]);
  return theme.fg("toolOutput", line);
}

function styleHelpLine(line: string, theme: Theme): string {
  if (line === "browser-pilot topics") return theme.fg("toolTitle", theme.bold(line));
  if (/^(Params|Examples|Actions|Related groups|Related):?$/.test(line.trim())) {
    return theme.fg("muted", theme.bold(line));
  }
  if (line.startsWith("Use when:")) {
    return theme.fg("muted", "Use when:") + theme.fg("toolOutput", line.slice(9));
  }
  const row = /^(\s{2})(\S+)(\s{2,})(.*)$/.exec(line);
  if (row) {
    return row[1] + theme.fg("accent", row[2]) + row[3] + theme.fg("toolOutput", row[4]);
  }
  return theme.fg("toolOutput", line);
}

function styleTabsLine(line: string, theme: Theme): string {
  const notice = noticeLine(line, theme);
  if (notice !== undefined) return notice;
  if (line.startsWith("Tabs: ")) return theme.fg("accent", line);
  const tab = /^(\s+)([* ]) (\d+)(\s+)(\S+)(.*)$/.exec(line);
  if (!tab) return theme.fg("toolOutput", line);
  return (
    tab[1] +
    theme.fg("accent", tab[2]) +
    " " +
    theme.fg("accent", tab[3]) +
    tab[4] +
    theme.fg("toolOutput", tab[5]) +
    theme.fg("muted", tab[6])
  );
}

function styleGenericLine(line: string, theme: Theme): string {
  const notice = noticeLine(line, theme);
  if (notice !== undefined) return notice;
  const keyValue = KEY_VALUE.exec(line);
  if (keyValue) {
    return (
      theme.fg("muted", keyValue[1]) +
      theme.fg("dim", ":") +
      " " +
      theme.fg("toolOutput", keyValue[2])
    );
  }
  return theme.fg("toolOutput", line);
}

function styleBodyLines(action: string, lines: string[], theme: Theme): string[] {
  switch (action) {
    case "snapshot":
      return lines.map((line) => styleSnapshotLine(line, theme));
    case "network":
      return lines.map((line) => styleNetworkLine(line, theme));
    case "console":
      return lines.map((line) => styleConsoleLine(line, theme));
    case "steps":
      return lines.map((line) => styleStepLine(line, theme));
    case "help":
      return lines.map((line) => styleHelpLine(line, theme));
    case "tabs":
      return lines.map((line) => styleTabsLine(line, theme));
    default:
      return lines.map((line) => styleGenericLine(line, theme));
  }
}

function renderOutput(details: BrowserPilotDetails, body: string[], theme: Theme): Component {
  if (body.length === 0) return new Text(theme.fg("muted", "(no output)"), 0, 0);
  const text = body.join("\n");
  if (details.action === "read" && details.format === "markdown") {
    return new Markdown(text, 0, 0, markdownTheme(theme));
  }
  if (details.action === "read" && details.format === "html") {
    return highlightedText(text, "html");
  }
  if (details.action === "eval") {
    const language = evalOutputLanguage(details, text);
    if (language !== undefined) return highlightedText(text, language);
  }
  return new Text(styleBodyLines(details.action, body, theme).join("\n"), 0, 0);
}

function renderFooters(footers: string[], theme: Theme): string {
  return footers
    .map((line) => {
      if (/^\[.*truncated/i.test(line)) return theme.fg("warning", line);
      if (line.startsWith("[Saved to")) return theme.fg("success", line);
      if (line.startsWith("Challenge:")) return theme.fg("warning", line);
      return theme.fg("muted", line);
    })
    .join("\n");
}

function resultMetaParts(details: BrowserPilotDetails): string[] {
  const parts: string[] = [];
  if (details.action === "read" && typeof details.format === "string") {
    parts.push(details.format);
  }
  if (details.action === "eval" && typeof details.resultType === "string") {
    parts.push(details.resultType);
  }
  if (
    (details.action === "read" || details.action === "eval") &&
    typeof details.chars === "number"
  ) {
    parts.push(`${details.chars} chars`);
  }
  return parts;
}

function resultHeader(details: BrowserPilotDetails, theme: Theme): string {
  let text = theme.fg("accent", details.action);
  if (details.status !== undefined) text += theme.fg("success", ` · ${details.status}`);
  if (details.tab !== undefined) text += theme.fg("dim", ` · tab ${details.tab}`);
  for (const part of resultMetaParts(details)) text += theme.fg("muted", ` · ${part}`);
  if (details.challenge) {
    text += theme.fg("warning", ` · ${details.challenge.type} ${details.challenge.severity}`);
  }
  if (details.truncated) text += theme.fg("warning", " · truncated");
  return text;
}

function resultPreview(
  details: BrowserPilotDetails,
  body: string[],
  expanded: boolean,
): string | undefined {
  const action = details.action;
  const firstBodyLine = body.find((line) => !isBlank(line));
  const inputPreview =
    INPUT_PREVIEW_ACTIONS.has(action) || (action === "clipboard" && details.op === "write");
  if (expanded) {
    if (details.preview && !inputPreview) return details.preview;
    if (action === "snapshot" && typeof details.snapshotNodes === "number") {
      return `${details.snapshotNodes} nodes`;
    }
    if (action === "console" && typeof details.count === "number") {
      return `${details.count} console entries`;
    }
    if (action === "tabs" && Array.isArray(details.tabs)) return `${details.tabs.length} tab(s)`;
    if (action === "cookies" && typeof details.count === "number") {
      return `${details.count} cookie(s)`;
    }
    return undefined;
  }
  if (action === "eval") return previewText(body.join(" "), COLLAPSED_SUMMARY_CHARS);
  if (inputPreview) return firstBodyLine;
  if (action === "snapshot" && typeof details.snapshotNodes === "number") {
    return `${details.snapshotNodes} nodes`;
  }
  if (action === "console" && typeof details.count === "number") {
    return `${details.count} console entries`;
  }
  if (action === "tabs" && Array.isArray(details.tabs)) return `${details.tabs.length} tab(s)`;
  if (action === "cookies" && typeof details.count === "number") {
    return `${details.count} cookie(s)`;
  }
  return details.preview ?? firstBodyLine;
}

function summaryText(
  details: BrowserPilotDetails,
  body: string[],
  expanded: boolean,
  theme: Theme,
): string | undefined {
  const lines: string[] = [];
  if (details.subject) {
    lines.push(theme.fg("toolOutput", previewText(details.subject, COLLAPSED_SUMMARY_CHARS)));
  }
  const preview = resultPreview(details, body, expanded);
  if (preview) lines.push(theme.fg("muted", previewText(preview, COLLAPSED_SUMMARY_CHARS)));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function expandHint(context: PilotRenderContext | undefined): string | undefined {
  if (!context?.keyHint) return undefined;
  return context.keyHint("app.tools.expand", "to expand") || undefined;
}

function addExpandedArgs(
  container: Container,
  context: PilotRenderContext | undefined,
  theme: Theme,
): void {
  if (!context?.args || context.state?.argsExpanded === true) return;
  container.addChild(new Spacer(1));
  container.addChild(new Text(expandedArgs(context.args, theme), 0, 0));
}

function renderErrorResult(
  body: string,
  details: BrowserPilotDetails,
  options: RenderOptions,
  theme: Theme,
  context: PilotRenderContext | undefined,
): Component {
  const message = details.error ?? body.split("\n").slice(0, 3).join("\n");
  const messageLines = new Set(message.split("\n"));
  const rest = body
    .split("\n")
    .filter((line, index) => index > 0 && !isBlank(line) && !messageLines.has(line));
  const container = new Container();
  container.addChild(new Text(theme.fg("error", message), 0, 0));
  if (options.expanded) {
    addExpandedArgs(container, context, theme);
    if (rest.length > 0) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", theme.bold("Details")), 0, 0));
      container.addChild(
        new Text(rest.map((line) => styleGenericLine(line, theme)).join("\n"), 0, 0),
      );
    }
  } else {
    const hints = rest.filter(
      (line) => line.startsWith("Hint:") || line.startsWith("Suggested next:"),
    );
    if (hints.length > 0) {
      container.addChild(new Text(hints.map((line) => theme.fg("muted", line)).join("\n"), 0, 0));
    }
    const hint = expandHint(context);
    if (hint) container.addChild(new Text(theme.fg("muted", hint), 0, 0));
  }
  return container;
}

export function renderPilotResult(
  result: RenderResultLike,
  options: RenderOptions,
  theme: Theme,
  context?: PilotRenderContext,
): Component {
  const body = firstText(result);
  if (options.isPartial) {
    return new Text(theme.fg("warning", body.split("\n")[0] || "Working…"), 0, 0);
  }

  const details = result.details as BrowserPilotDetails | undefined;
  if (!details) return new Text(theme.fg("dim", body.split("\n")[0] ?? ""), 0, 0);

  if (result.isError || details.error) {
    return renderErrorResult(body, details, options, theme, context);
  }

  const { content } = bodyLines(body);
  const { body: resultBody, footers } = splitResultBody(details.action, content);

  const container = new Container();
  container.addChild(new Text(resultHeader(details, theme), 0, 0));
  const summary = summaryText(details, resultBody, options.expanded, theme);
  if (summary) container.addChild(new Text(summary, 0, 0));
  if (details.url) {
    container.addChild(
      new Text(theme.fg("muted", shortenUrl(details.url, RESULT_URL_CHARS)), 0, 0),
    );
  }
  if (details.title) {
    container.addChild(new Text(theme.fg("dim", previewText(details.title, 80)), 0, 0));
  }
  if (details.savedPath) {
    container.addChild(new Text(theme.fg("dim", `saved: ${details.savedPath}`), 0, 0));
  }

  if (options.expanded) {
    addExpandedArgs(container, context, theme);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", theme.bold("Output")), 0, 0));
    container.addChild(renderOutput(details, resultBody, theme));
    if (footers.length > 0) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(renderFooters(footers, theme), 0, 0));
    }
  } else {
    const hint = expandHint(context);
    if (hint) container.addChild(new Text(theme.fg("muted", hint), 0, 0));
  }

  return container;
}
