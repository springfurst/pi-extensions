import type { TruncationBinding } from "./output";
import type { RenderResult } from "./types";

/** Site-specific handler methods. Update when a handler's method changes. */
const SITE_METHODS = new Set<string>([
  "github-raw",
  "github-tree",
  "github-commit",
  "github-pr",
  "github-issue",
  "github-issues",
  "github-repo",
  "github-actions-run",
  "github-actions-job",
  "gitlab-raw",
  "gitlab-tree",
  "gitlab-issue",
  "gitlab-mr",
  "gitlab-repo",
  "npm",
  "pypi",
  "crates.io",
  "wikipedia",
  "arxiv",
  "semantic-scholar",
  "pubmed",
  "rfc",
  "docs.rs",
  "mdn",
  "hackernews",
  "reddit",
  "stackexchange",
]);

/** In-process, external, and browser reader backends. */
const READER_METHODS = new Set<string>(["readability", "trafilatura", "lynx", "jina", "browser"]);

/** Format-specific routes and digest alternatives that skip article extraction. */
const FORMAT_METHODS = new Set<string>([
  "json",
  "feed",
  "text",
  "alternate-markdown",
  "md-suffix",
  "content-negotiation",
  "alternate-feed",
  "llms.txt",
]);

export type ParserKind = "site" | "reader" | "format" | "raw" | "error" | "unknown";

/** Classify a pipeline `method` into a coarse parser family for analysis. */
export function classifyParser(method: string): ParserKind {
  if (method === "raw" || method === "raw-html") return "raw";
  if (method === "failed" || method === "none") return "error";
  if (SITE_METHODS.has(method)) return "site";
  if (READER_METHODS.has(method)) return "reader";
  if (FORMAT_METHODS.has(method)) return "format";
  return "unknown";
}

/** Tool input parameters recorded for one `web_fetch` call. */
export interface FetchUsageParams {
  url: string;
  raw?: boolean;
  max_chars?: number;
  save_path?: string;
}

export interface FetchUsageBodyInput {
  params: FetchUsageParams;
  selector?: string;
  result?: RenderResult;
  charCount?: number;
  truncated: boolean;
  truncationBinding?: TruncationBinding;
  savedPath?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Build the `web_fetch`-specific part of a usage record. `params` (the tool
 * input) is included only when `includeArgs` is true.
 */
export function buildFetchBody(
  input: FetchUsageBodyInput,
  includeArgs: boolean,
): Record<string, unknown> {
  const method = input.result?.method ?? "failed";
  const finalUrl = input.result?.finalUrl ?? input.params.url;
  const body: Record<string, unknown> = {
    requestedUrl: input.result?.url ?? input.params.url,
    finalUrl,
    host: hostOf(finalUrl),
    parser: method,
    parserKind: classifyParser(method),
    truncated: input.truncated,
  };
  if (includeArgs) body.params = input.params;
  if (input.selector) body.selector = input.selector;
  if (input.result) {
    body.contentType = input.result.contentType;
    if (input.result.status !== undefined) body.status = input.result.status;
    body.notes = input.result.notes;
  }
  if (input.charCount !== undefined) body.charCount = input.charCount;
  if (input.truncationBinding) body.truncationBinding = input.truncationBinding;
  if (input.savedPath) body.savedPath = input.savedPath;
  return body;
}
