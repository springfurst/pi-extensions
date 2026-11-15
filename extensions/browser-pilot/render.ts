import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { previewText, shortenUrl } from "./output";
import { flattenCall } from "./call";
import type { BrowserPilotCall, BrowserPilotDetails, BrowserPilotParams } from "./types";

interface RenderResultLike {
  details?: unknown;
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface RenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

const CALL_DETAIL_CHARS = 100;
const FALLBACK_LINE_CHARS = 120;
const RESULT_URL_CHARS = 96;
const EXPANDED_LINES = 24;

const PAGE_HEADER = /^Tab \d+ · /;

function firstText(result: RenderResultLike): string {
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

/** The arguments worth showing next to the action name, most specific first. */
function callDetail(args: BrowserPilotParams): string | undefined {
  const parts: string[] = [];
  if (args.op !== undefined) parts.push(String(args.op));
  if (args.check !== undefined) parts.push(String(args.check));
  if (args.for !== undefined) parts.push(`for ${args.for}`);
  if (args.target !== undefined) parts.push(String(args.target));
  if (args.direction !== undefined) parts.push(String(args.direction));
  if (args.ref) parts.push(String(args.ref));
  else if (args.selector) parts.push(previewText(String(args.selector), 48));
  if (args.url) parts.push(shortenUrl(String(args.url), 80));
  if (args.key) parts.push(String(args.key));
  if (args.values && args.values.length > 0) parts.push(args.values.join(", "));
  if (args.text !== undefined) parts.push(`"${previewText(String(args.text), 40)}"`);
  else if (args.text_env) parts.push(`$${String(args.text_env)}`);
  else if (args.text_file) parts.push(previewText(String(args.text_file), 40));
  if (args.expression) parts.push(previewText(String(args.expression), 50));
  if (args.expected !== undefined) parts.push(`"${previewText(String(args.expected), 30)}"`);
  if (args.format !== undefined) parts.push(String(args.format));
  if (args.level !== undefined) parts.push(String(args.level));
  if (args.policy !== undefined) parts.push(String(args.policy));
  if (args.group) parts.push(`group ${String(args.group)}`);
  if (args.help_action) parts.push(String(args.help_action));
  if (args.path) parts.push(previewText(String(args.path), 60));
  if (args.name) parts.push(String(args.name));
  if (args.id) parts.push(String(args.id));
  if (args.filter) parts.push(previewText(String(args.filter), 40));
  if (parts.length === 0) return undefined;
  return previewText(parts.join(" · "), CALL_DETAIL_CHARS);
}

export function renderPilotCall(call: BrowserPilotCall, theme: Theme): Component {
  const args = flattenCall(call);
  const action = typeof args.action === "string" ? args.action : "browser-pilot";
  let text = theme.fg("toolTitle", theme.bold("browser-pilot "));
  text += theme.fg("accent", action);
  const detail = callDetail(args);
  if (detail !== undefined) text += theme.fg("dim", ` · ${detail}`);
  if (args.tab !== undefined) text += theme.fg("dim", ` · tab ${args.tab}`);
  return new Text(text, 0, 0);
}

/** Split a result body into its page header and the action-specific lines. */
function bodyLines(body: string): { header: string; content: string[] } {
  const lines = body.split("\n");
  if (lines.length > 0 && PAGE_HEADER.test(lines[0])) {
    return { header: lines[0], content: lines.slice(1) };
  }
  return { header: "", content: lines };
}

export function renderPilotResult(
  result: RenderResultLike,
  options: RenderOptions,
  theme: Theme,
): Component {
  const body = firstText(result);
  if (options.isPartial) {
    return new Text(theme.fg("warning", body.split("\n")[0] || "Working…"), 0, 0);
  }

  const details = result.details as BrowserPilotDetails | undefined;
  if (!details) return new Text(theme.fg("dim", body.split("\n")[0] ?? ""), 0, 0);

  if (result.isError || details.error) {
    const message = details.error ?? body.split("\n").slice(0, 3).join("\n");
    return new Text(theme.fg("error", message), 0, 0);
  }

  const { content } = bodyLines(body);
  const firstIndex = content.findIndex((line) => line.trim().length > 0);
  const firstLine = firstIndex >= 0 ? content[firstIndex] : undefined;

  let text = theme.fg("accent", details.action);
  if (details.status !== undefined) text += theme.fg("success", ` · ${details.status}`);
  if (details.tab !== undefined) text += theme.fg("dim", ` · tab ${details.tab}`);
  if (details.challenge) {
    text += theme.fg("warning", ` · ${details.challenge.type} ${details.challenge.severity}`);
  }
  if (details.truncated) text += theme.fg("warning", " · truncated");

  const hasSubject = Boolean(details.subject);
  const hasPreview = Boolean(details.preview);
  if (details.subject)
    text += `\n${theme.fg("text", previewText(details.subject, FALLBACK_LINE_CHARS))}`;
  if (details.preview)
    text += `\n${theme.fg("dim", previewText(details.preview, FALLBACK_LINE_CHARS))}`;
  if (!hasSubject && !hasPreview && firstLine) {
    text += `\n${theme.fg("dim", previewText(firstLine, FALLBACK_LINE_CHARS))}`;
  }
  if (details.url) text += `\n${theme.fg("muted", shortenUrl(details.url, RESULT_URL_CHARS))}`;
  if (details.title) text += `\n${theme.fg("dim", previewText(details.title, 80))}`;
  if (details.savedPath) text += `\n${theme.fg("dim", `saved: ${details.savedPath}`)}`;

  if (options.expanded) {
    // The collapsed row already showed the first line, and the header repeats the URL.
    const rest = hasSubject || hasPreview ? content : content.slice(firstIndex + 1);
    const lines = rest.filter((line, index) => index > 0 || line.trim().length > 0);
    for (const line of lines.slice(0, EXPANDED_LINES)) text += `\n${theme.fg("dim", line)}`;
    if (lines.length > EXPANDED_LINES) text += `\n${theme.fg("muted", "…")}`;
  }

  return new Text(text, 0, 0);
}
