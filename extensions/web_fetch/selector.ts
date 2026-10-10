// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

/** Inclusive line range describing one selector segment (e.g. `50-100`, `301-`, or `50+10`). */
export interface LineRange {
  startLine: number;
  endLine: number | undefined;
}

/**
 * A parsed URL selector. Mirrors the file-read grammar:
 * `:N`, `:N-M`, `:N+M`, `:A-B,C-D`, `:-N` (tail), `:raw`, and `raw` combined
 * with a range or tail.
 */
export type ParsedSelector =
  | { kind: "none" }
  | { kind: "raw" }
  | { kind: "lines"; ranges: [LineRange, ...LineRange[]]; raw?: boolean }
  | { kind: "tail"; count: number; raw?: boolean };

export interface ParsedReadUrlTarget {
  path: string;
  sel: ParsedSelector;
}

const LINE_RANGE_CHUNK_SOURCE = String.raw`L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?`;
const LINE_RANGE_CHUNK_RE = new RegExp(`^${LINE_RANGE_CHUNK_SOURCE}$`, "i");
const TAIL_SELECTOR_RE = /^-(\d+)$/;

function parseChunk(sel: string, pinBare: boolean): LineRange | null {
  const lineMatch = LINE_RANGE_CHUNK_RE.exec(sel);
  if (!lineMatch) return null;
  const rawStart = Number.parseInt(lineMatch[1]!, 10);
  if (rawStart < 1) {
    throw new Error("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
  }
  // `..` is a forgiving alias for `-` (e.g. `2724..2727` == `2724-2727`).
  const sep = lineMatch[2] === ".." ? "-" : lineMatch[2];
  const rhs = lineMatch[3] ? Number.parseInt(lineMatch[3], 10) : undefined;
  let rawEnd: number | undefined;
  if (sep === "+") {
    if (rhs === undefined || rhs < 1) {
      throw new Error(`Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`);
    }
    rawEnd = rawStart + rhs - 1;
  } else if (sep === "-") {
    // `301-` is shorthand for "from 301 onward" — equivalent to a lone bare `301`.
    if (rhs !== undefined) {
      if (rhs < rawStart) {
        throw new Error(`Invalid range ${rawStart}-${rhs}: end must be >= start.`);
      }
      rawEnd = rhs;
    }
  } else if (pinBare) {
    rawEnd = rawStart;
  }
  return { startLine: rawStart, endLine: rawEnd };
}

/**
 * Parse a comma-separated list of line ranges (e.g. `5-16,960-973`). Ranges are
 * returned sorted with overlapping or adjacent ranges merged.
 */
export function parseLineRanges(sel: string): [LineRange, ...LineRange[]] | null {
  const chunks = sel.split(",");
  // A lone `:50` means "from line 50"; inside a comma list a bare number is one line.
  const pinBare = chunks.length > 1;
  const parsed: LineRange[] = [];
  for (const chunk of chunks) {
    const range = parseChunk(chunk, pinBare);
    if (!range) return null;
    parsed.push(range);
  }
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => a.startLine - b.startLine);

  const merged: LineRange[] = [parsed[0]!];
  for (let i = 1; i < parsed.length; i++) {
    const current = parsed[i]!;
    const last = merged[merged.length - 1]!;
    // Open-ended (endLine undefined) means "to EOF" — any later range is absorbed.
    if (last.endLine === undefined) continue;
    if (current.startLine <= last.endLine + 1) {
      if (current.endLine === undefined || current.endLine > last.endLine) {
        merged[merged.length - 1] = { startLine: last.startLine, endLine: current.endLine };
      }
      continue;
    }
    merged.push(current);
  }
  return merged as [LineRange, ...LineRange[]];
}

/** Parse a `-N` tail selector into its line count (`:-60` → 60 last lines). */
export function parseTailCount(sel: string): number | null {
  const match = TAIL_SELECTOR_RE.exec(sel);
  if (!match) return null;
  const count = Number.parseInt(match[1]!, 10);
  if (count < 1) throw new Error("Tail selector -0 is invalid; use :-N with N >= 1.");
  return count;
}

/** Restore the double slash in a collapsed HTTP URL scheme. */
export function repairCollapsedScheme(value: string): string {
  const m = value.match(/^(https?):\/(?!\/)/i);
  return m ? `${m[1]}://${value.slice(m[0].length)}` : value;
}

function isReadableUrlPath(value: string): boolean {
  return /^https?:\/\/?/i.test(value) || /^www\./i.test(value);
}

function readSelectorRangeStart(selector: string): number | undefined {
  try {
    const start = parseLineRanges(selector)?.[0].startLine;
    return start !== undefined && Number.isFinite(start) ? start : undefined;
  } catch {
    return undefined;
  }
}

function isUrlSelectorToken(token: string): boolean {
  if (token.toLowerCase() === "raw") return true;
  if (/^-\d+$/.test(token)) return Number.parseInt(token.slice(1), 10) > 0;
  return readSelectorRangeStart(token) !== undefined;
}

/**
 * True when `colonIndex` falls inside the URL authority (the `host:port` part)
 * rather than the path, query, or fragment. Selectors are only peeled from the
 * latter, so a bare `host:port` keeps its port.
 */
function colonIsInAuthority(path: string, colonIndex: number): boolean {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(path);
  const authorityStart = scheme ? scheme[0].length : 0;
  const authorityEnd = path.slice(authorityStart).search(/[/?#]/);
  if (authorityEnd === -1) return colonIndex >= authorityStart;
  return colonIndex >= authorityStart && colonIndex < authorityStart + authorityEnd;
}

/**
 * Peel one or more selector tokens off the right of a URL string. Walks back
 * through trailing `:tok` segments while each token looks like a selector and
 * leaves a string that still parses as a URL.
 */
export function tryExtractEmbeddedUrlSelector(
  readPath: string,
): { path: string; sels: string[] } | null {
  let basePath = readPath;
  const sels: string[] = [];
  while (true) {
    const lastColonIndex = basePath.lastIndexOf(":");
    if (lastColonIndex <= 0) break;

    const candidate = basePath.slice(lastColonIndex + 1);
    const remainder = basePath.slice(0, lastColonIndex);
    if (!isReadableUrlPath(remainder)) break;
    if (colonIsInAuthority(basePath, lastColonIndex)) break;
    if (!isUrlSelectorToken(candidate)) break;

    try {
      new URL(
        remainder.startsWith("http://") || remainder.startsWith("https://")
          ? remainder
          : `https://${remainder}`,
      );
    } catch {
      break;
    }

    sels.unshift(candidate);
    basePath = remainder;
  }
  if (sels.length === 0) return null;
  return { path: basePath, sels };
}

/**
 * Split a URL read target into its URL and selector. Returns `null` when the
 * string is not an HTTP(S) or `www.` target.
 */
export function parseReadUrlTarget(readPath: string): ParsedReadUrlTarget | null {
  const repaired = repairCollapsedScheme(readPath);
  const embedded = tryExtractEmbeddedUrlSelector(repaired);
  const urlPath = embedded?.path ?? repaired;
  if (!isReadableUrlPath(urlPath)) return null;

  let raw = false;
  let ranges: [LineRange, ...LineRange[]] | undefined;
  let tail: number | undefined;
  for (const token of embedded?.sels ?? []) {
    if (token.toLowerCase() === "raw") {
      raw = true;
      continue;
    }
    if (ranges !== undefined || tail !== undefined) {
      throw new Error(
        "URL selector has multiple range groups; combine them with commas (e.g. `:5-10,20-30`).",
      );
    }
    ranges = parseLineRanges(token) ?? undefined;
    if (ranges !== undefined) continue;
    const count = parseTailCount(token);
    if (count === null) throw new Error(`Invalid URL line selector: ${token}`);
    tail = count;
  }

  const sel: ParsedSelector = ranges
    ? { kind: "lines", ranges, raw }
    : tail !== undefined
      ? { kind: "tail", count: tail, raw }
      : raw
        ? { kind: "raw" }
        : { kind: "none" };
  return { path: urlPath, sel };
}

/** True when the selector requests verbatim output, alone or with a range. */
export function selectorWantsRaw(sel: ParsedSelector): boolean {
  return sel.kind === "raw" || ((sel.kind === "lines" || sel.kind === "tail") && sel.raw === true);
}

/** Slice rendered text by a line-range or tail selector. */
export function applyLineSelector(content: string, sel: ParsedSelector): string {
  if (sel.kind !== "lines" && sel.kind !== "tail") return content;
  const lines = content.split("\n");
  if (sel.kind === "tail") {
    const start = Math.max(0, lines.length - sel.count);
    return lines.slice(start).join("\n");
  }
  const out: string[] = [];
  for (const range of sel.ranges) {
    const start = Math.max(0, range.startLine - 1);
    const end =
      range.endLine === undefined
        ? lines.length - 1
        : Math.min(range.endLine - 1, lines.length - 1);
    for (let i = start; i <= end && i < lines.length; i++) out.push(lines[i]!);
  }
  return out.join("\n");
}

/** Render a selector back to its `:…` display form, or `undefined` when absent. */
export function formatSelector(sel: ParsedSelector): string | undefined {
  if (sel.kind === "none") return undefined;
  if (sel.kind === "raw") return ":raw";
  if (sel.kind === "tail") return `:${sel.raw ? "raw:" : ""}-${sel.count}`;
  const ranges = sel.ranges
    .map((range) =>
      range.endLine === undefined ? `${range.startLine}-` : `${range.startLine}-${range.endLine}`,
    )
    .join(",");
  return `:${sel.raw ? "raw:" : ""}${ranges}`;
}
