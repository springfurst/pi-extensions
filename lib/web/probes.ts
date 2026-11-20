/**
 * Alternative representations of one page, tried in order.
 *
 * A site may publish the same content as markdown (`page.md`), as a scoped
 * `llms.txt`, or through content negotiation. The transport already handles
 * robots, pacing, and conditional GETs; this module decides which candidate
 * URLs to ask for, in which order, and refuses to ask for the same
 * representation twice.
 */

import { looksLikeHtml } from "../dom";
import type { TransferResult } from "./transfer";

export type ProbeKind = "md" | "llms" | "negotiation";

/** Fetch one candidate through the shared transport. */
export type ProbeFetch = (
  url: string,
  options?: {
    headers?: Record<string, string>;
    timeoutSeconds?: number;
    cookies?: string;
  },
) => Promise<TransferResult>;

export interface ProbeOptions {
  fetch: ProbeFetch;
  signal?: AbortSignal;
  /** Wall-clock budget for one candidate, in seconds. */
  timeoutSeconds?: number;
  /** Cookies from a warm profile; a function resolves them for each candidate URL. */
  cookies?: string | ((url: string) => string | undefined | Promise<string | undefined>);
  /** Minimum characters for a candidate to count as content. */
  minChars?: number;
  /** Kinds to try, in order. Defaults to markdown, llms, then negotiation. */
  kinds?: ProbeKind[];
  /** Candidates already attempted in this tool call, shared across calls. */
  seen?: Set<string>;
}

/** A candidate that produced usable content. */
export interface ProbeHit {
  kind: ProbeKind;
  url: string;
  content: string;
  contentType: string;
}

interface Candidate {
  kind: ProbeKind;
  url: string;
  headers?: Record<string, string>;
  timeoutSeconds?: number;
}

const DEFAULT_MIN_CHARS = 100;
/** A scoped `llms.txt` probe may not spend the whole tool deadline. */
const LLMS_PROBE_SECONDS = 5;
const MARKDOWN_ACCEPT = "text/markdown, text/plain;q=0.9, text/html;q=0.8";

/**
 * Try each requested kind in order and return the first usable candidate.
 * Candidates that repeat within `seen` are skipped, so composing several calls
 * in one tool invocation never probes the same representation twice.
 */
export async function probe(url: string, options: ProbeOptions): Promise<ProbeHit | undefined> {
  const kinds = options.kinds ?? ["md", "llms", "negotiation"];
  const seen = options.seen ?? new Set<string>();
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS;

  for (const kind of kinds) {
    for (const candidate of candidatesFor(kind, url, options.timeoutSeconds)) {
      const key = `${candidate.url}\n${candidate.headers?.Accept ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (options.signal?.aborted) return undefined;
      const cookies =
        typeof options.cookies === "function"
          ? await options.cookies(candidate.url)
          : options.cookies;
      const result = await options.fetch(candidate.url, {
        headers: candidate.headers,
        timeoutSeconds: candidate.timeoutSeconds,
        cookies,
      });
      if (result.ok && result.content.trim().length >= minChars && !looksLikeHtml(result.content)) {
        return {
          kind: candidate.kind,
          url: candidate.url,
          content: result.content,
          contentType: result.contentType,
        };
      }
    }
  }
  return undefined;
}

/**
 * Build `llms.txt`/`llms.md` candidates scoped to the requested URL's ancestor
 * directories, from deepest to shallowest. The site root is only probed for the
 * root URL itself, not for pages below it.
 */
export function buildLlmEndpointCandidates(url: string): string[] {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/") {
      return [
        `${parsed.origin}/.well-known/llms.txt`,
        `${parsed.origin}/llms.txt`,
        `${parsed.origin}/llms.md`,
      ];
    }

    const trimmedPath = parsed.pathname.replace(/\/+$/, "");
    const segments = trimmedPath.split("/").filter(Boolean);
    const scopeDepth = parsed.pathname.endsWith("/")
      ? segments.length
      : Math.max(segments.length - 1, 1);
    const endpoints: string[] = [];

    for (let depth = scopeDepth; depth >= 1; depth--) {
      const scope = `/${segments.slice(0, depth).join("/")}/`;
      endpoints.push(`${parsed.origin}${scope}llms.txt`, `${parsed.origin}${scope}llms.md`);
    }
    return endpoints;
  } catch {
    return [];
  }
}

function candidatesFor(kind: ProbeKind, url: string, timeoutSeconds?: number): Candidate[] {
  switch (kind) {
    case "md":
      return markdownCandidates(url).map((candidate) => ({ kind, url: candidate }));
    case "llms":
      return buildLlmEndpointCandidates(url).map((candidate) => ({
        kind,
        url: candidate,
        timeoutSeconds: Math.min(timeoutSeconds ?? LLMS_PROBE_SECONDS, LLMS_PROBE_SECONDS),
      }));
    case "negotiation":
      return [{ kind, url, headers: { Accept: MARKDOWN_ACCEPT } }];
  }
}

function markdownCandidates(url: string): string[] {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/")) {
      return [`${parsed.origin}${parsed.pathname}index.html.md`];
    }
    return [`${parsed.origin}${parsed.pathname}.md`];
  } catch {
    return [];
  }
}
