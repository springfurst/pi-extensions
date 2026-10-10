// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { formatBytes } from "../../lib/format";
import type { RenderResult } from "./types";

/** Collapse blank runs and trim rendered output. */
export function cleanOutput(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Clean rendered output and report whether it exceeds the render cap. The
 * content is not sliced: callers apply the cap only once, after selectors and
 * `save_path` have seen the full body.
 */
export function finalizeOutput(
  content: string,
  maxChars: number,
): { content: string; truncated: boolean } {
  const cleaned = cleanOutput(content);
  return { content: cleaned, truncated: cleaned.length > maxChars };
}

/** Slice text to the render cap, reporting whether anything was cut. */
export function applyRenderCap(
  content: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false };
  return { text: content.slice(0, maxChars), truncated: true };
}

/** The `URL / Content-Type / Method / Notes` header prepended to every read. */
export function buildHeader(result: RenderResult): string {
  let output = `URL: ${result.finalUrl}\n`;
  output += `Content-Type: ${result.contentType}\n`;
  output += `Method: ${result.method}\n`;
  if (result.notes.length > 0) output += `Notes: ${result.notes.join("; ")}\n`;
  output += "\n---\n\n";
  return output;
}

export interface ModelLimit {
  text: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
  totalBytes: number;
  outputBytes: number;
}

/** Apply pi's model-safe line/byte limit to text that will be returned to the model. */
export function applyModelSafeLimit(text: string): ModelLimit {
  const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  return {
    text: result.content,
    truncated: result.truncated,
    totalLines: result.totalLines,
    outputLines: result.outputLines,
    totalBytes: result.totalBytes,
    outputBytes: result.outputBytes,
  };
}

export type TruncationBinding = "render" | "model";

/** Explain which limit cut the output and how to get more of it. */
export function truncationHint(
  binding: TruncationBinding,
  maxChars: number,
  limit: ModelLimit,
  savedPath?: string,
): string {
  const saveHint = savedPath
    ? `; full output saved to ${savedPath}`
    : " or pass save_path to write the full output to a file";
  if (binding === "render") {
    return `\n\n[Rendered content exceeds fetch.maxChars (${maxChars} characters); increase fetch.maxChars, request a selector range${saveHint}.]`;
  }
  const nextRange = `:${limit.outputLines + 1}-${limit.totalLines}`;
  return `\n\n[Output truncated to ${DEFAULT_MAX_LINES} lines / ${formatBytes(DEFAULT_MAX_BYTES)}; request a selector range (e.g. ${nextRange})${saveHint}.]`;
}
