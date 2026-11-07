import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { BrowserPilotDetails, BrowserPilotParams } from "./types";

interface RenderResultLike {
  details?: unknown;
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface RenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

function firstText(result: RenderResultLike): string {
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

export function renderPilotCall(args: BrowserPilotParams, theme: Theme): Component {
  const action = typeof args.action === "string" ? args.action : "browser-pilot";
  let text = theme.fg("toolTitle", theme.bold("browser-pilot "));
  text += theme.fg("accent", action);
  const detail =
    args.url ??
    args.ref ??
    args.selector ??
    args.topic ??
    args.op ??
    args.key ??
    args.path ??
    args.expression;
  if (detail !== undefined) text += theme.fg("dim", ` · ${String(detail).slice(0, 120)}`);
  if (args.tab !== undefined) text += theme.fg("dim", ` · tab ${args.tab}`);
  return new Text(text, 0, 0);
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

  let text = theme.fg("accent", details.action);
  if (details.status !== undefined) text += theme.fg("success", ` · ${details.status}`);
  if (details.tab !== undefined) text += theme.fg("dim", ` · tab ${details.tab}`);
  if (details.challenge) {
    text += theme.fg("warning", ` · ${details.challenge.type} ${details.challenge.severity}`);
  }
  if (details.truncated) text += theme.fg("warning", " · truncated");
  if (details.url) text += `\n${theme.fg("muted", details.url)}`;
  if (details.title) text += `\n${theme.fg("dim", details.title)}`;
  if (details.savedPath) text += `\n${theme.fg("dim", `saved: ${details.savedPath}`)}`;

  if (options.expanded) {
    const lines = body.split("\n").slice(0, 24);
    for (const line of lines) text += `\n${theme.fg("dim", line)}`;
    if (body.split("\n").length > lines.length) {
      text += `\n${theme.fg("muted", "…")}`;
    }
  }

  return new Text(text, 0, 0);
}
