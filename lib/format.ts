// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

/** Format a number with K/M/B suffix for compact display. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n < 1_000) return n.toString();
  if (n < 10_000) return `${trim1(n / 1_000)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
  if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
  if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n < 10_000_000_000) return `${trim1(n / 1_000_000_000)}B`;
  return `${Math.round(n / 1_000_000_000)}B`;
}

/** Format with up to one decimal place, dropping a trailing `.0`. */
function trim1(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** Format a byte count as `512B`, `1.5KB`, `2.3MB`, or `1.2GB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/** Truncate a string to `maxLen` characters, appending an ellipsis when cut. */
export function truncate(str: string, maxLen: number, ellipsis = "…"): string {
  if (str.length <= maxLen) return str;
  const sliceLen = Math.max(0, maxLen - ellipsis.length);
  return `${str.slice(0, sliceLen)}${ellipsis}`;
}

/** Pluralize a label for a count, e.g. `3 files`, `1 error`. */
export function formatCount(label: string, count: number): string {
  const safeCount = Number.isFinite(count) ? count : 0;
  return `${safeCount} ${pluralize(label, safeCount)}`;
}

function pluralize(label: string, count: number): string {
  if (count === 1) return label;
  if (label.endsWith("s")) return label;
  return `${label}s`;
}

/** Format an age in seconds as `just now`, `5m ago`, `3h ago`, `2d ago`, `3w ago`, or `4mo ago`. */
export function formatAge(ageSeconds: number | null | undefined): string {
  if (!ageSeconds) return "";
  const mins = Math.floor(ageSeconds / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (months > 0) return `${months}mo ago`;
  if (weeks > 0) return `${weeks}w ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

/** Decode the small set of HTML entities produced by feeds and scraper markup. */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
}

/** Collapse runs of whitespace, returning `undefined` for missing, non-string, or blank values. */
export function normalizeSearchText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : undefined;
}
