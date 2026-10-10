// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { formatBytes } from "../../lib/format";
import type { RenderResult } from "./types";

/** Cap and clean rendered output: collapse blank runs, trim, and slice. */
export function finalizeOutput(
  content: string,
  maxChars: number,
): { content: string; truncated: boolean } {
  const cleaned = content.replace(/\n{3,}/g, "\n\n").trim();
  const truncated = cleaned.length > maxChars;
  return { content: cleaned.slice(0, maxChars), truncated };
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
    return `\n\n[Content truncated at fetch.maxChars (${maxChars} characters); increase fetch.maxChars, request a selector range${saveHint}.]`;
  }
  const nextRange = `:${limit.outputLines + 1}-${limit.totalLines}`;
  return `\n\n[Output truncated to ${DEFAULT_MAX_LINES} lines / ${formatBytes(DEFAULT_MAX_BYTES)}; request a selector range (e.g. ${nextRange})${saveHint}.]`;
}
