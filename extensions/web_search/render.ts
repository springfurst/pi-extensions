import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { StructuredSource, WebSearchDetails } from "./tool";

interface RenderArgs {
  query?: unknown;
  recency?: unknown;
  limit?: unknown;
}

interface RenderResultLike {
  details?: unknown;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
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

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function renderSearchCall(args: RenderArgs, theme: Theme): Component {
  let text = theme.fg("toolTitle", theme.bold("web_search "));
  text += theme.fg("accent", typeof args.query === "string" ? args.query : "");
  const meta: string[] = [];
  if (typeof args.recency === "string") meta.push(`recency:${args.recency}`);
  if (typeof args.limit === "number") meta.push(`limit:${args.limit}`);
  if (meta.length > 0) text += theme.fg("dim", ` (${meta.join(", ")})`);
  return new Text(text, 0, 0);
}

export function renderSearchResult(
  result: RenderResultLike,
  options: RenderOptions,
  theme: Theme,
): Component {
  if (options.isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);

  const details = result.details as WebSearchDetails | undefined;
  if (details?.error) {
    return new Text(theme.fg("error", firstText(result) || details.error), 0, 0);
  }

  const sources: StructuredSource[] = Array.isArray(details?.sources)
    ? details.sources
    : Array.isArray(result.structuredContent)
      ? (result.structuredContent as StructuredSource[])
      : [];
  const engines = details?.engines?.length ? details.engines.join(", ") : (details?.provider ?? "");
  let text = theme.fg("success", `${sources.length} source${sources.length === 1 ? "" : "s"}`);
  if (engines) text += theme.fg("dim", ` · ${engines}`);
  if (details?.notes?.length) text += `\n${theme.fg("warning", details.notes.join("; "))}`;

  const visible = sources.slice(0, options.expanded ? 20 : 5);
  for (const [index, source] of visible.entries()) {
    text += `\n${theme.fg("muted", `[${index + 1}] ${source.title}`)} ${theme.fg("dim", hostOf(source.url))}`;
    if (source.snippet && options.expanded) text += `\n    ${theme.fg("dim", source.snippet)}`;
  }
  if (!options.expanded && sources.length > visible.length) {
    text += `\n${theme.fg("muted", `… ${sources.length - visible.length} more`)}`;
  }

  return new Text(text, 0, 0);
}
