import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export interface WebFetchDetails {
  url: string;
  finalUrl: string;
  contentType: string;
  method: string;
  truncated: boolean;
  truncationBinding?: "render" | "model";
  notes: string[];
  savedPath?: string;
  selector?: string;
}

interface RenderArgs {
  url?: unknown;
  raw?: unknown;
}

interface RenderResultLike {
  details?: unknown;
  content: Array<{ type: string; text?: string }>;
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

export function renderFetchCall(args: RenderArgs, theme: Theme): Component {
  const url = typeof args.url === "string" ? args.url : "";
  let text = theme.fg("toolTitle", theme.bold("web_fetch "));
  text += theme.fg("accent", url);
  if (args.raw === true) text += theme.fg("dim", " (raw)");
  return new Text(text, 0, 0);
}

export function renderFetchResult(
  result: RenderResultLike,
  options: RenderOptions,
  theme: Theme,
): Component {
  if (options.isPartial) return new Text(theme.fg("warning", "Fetching…"), 0, 0);

  const details = result.details as WebFetchDetails | undefined;
  if (!details) return new Text(theme.fg("dim", firstText(result).split("\n")[0] ?? ""), 0, 0);

  if (details.method === "failed") {
    const message = firstText(result).split("\n").slice(0, 2).join("\n");
    return new Text(theme.fg("error", message || "Fetch failed"), 0, 0);
  }

  let text = theme.fg("success", details.method);
  text += theme.fg("dim", ` · ${details.contentType}`);
  if (details.selector) text += theme.fg("dim", ` · ${details.selector}`);
  if (details.truncated) text += theme.fg("warning", " (truncated)");
  text += `\n${theme.fg("muted", details.finalUrl)}`;
  if (details.savedPath) text += `\n${theme.fg("dim", `saved: ${details.savedPath}`)}`;
  if (details.notes.length > 0) text += `\n${theme.fg("dim", details.notes.join("; "))}`;

  if (options.expanded) {
    const body = firstText(result);
    const lines = body.split("\n").slice(0, 40);
    for (const line of lines) text += `\n${theme.fg("dim", line)}`;
    if (body.split("\n").length > lines.length) {
      text += `\n${theme.fg("muted", "… (expand or use a selector for more)")}`;
    }
  }

  return new Text(text, 0, 0);
}
