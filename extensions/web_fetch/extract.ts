// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { Readability } from "@mozilla/readability";
import { withHardTimeout } from "../../lib/http";
import { parseDocument } from "../../lib/dom";
import { htmlToBasicMarkdown } from "./markdown";
import type { ExecFn, FetchContext } from "./types";

/** Cap on a single remote reader call, so one stall cannot starve local backends. */
const REMOTE_READER_MAX_MS = 10_000;
const JINA_MARKER = "Markdown Content:";
const JINA_MAX_BYTES = 2 * 1024 * 1024;

export interface HtmlRender {
  content: string;
  ok: boolean;
  method: string;
}

/**
 * Render HTML to markdown by trying reader backends in order: Readability
 * (in-process), `trafilatura`, `lynx`, Jina, then a headless browser. Every
 * backend's output must clear the same quality gate. When none does, the best
 * low-quality output is returned so the caller can still fall back to targeted
 * probes or raw HTML.
 */
export async function renderHtmlToText(
  html: string,
  url: string,
  ctx: FetchContext,
): Promise<HtmlRender> {
  const runners: Array<{ method: string; run: () => Promise<string | null> }> = [
    { method: "readability", run: () => Promise.resolve(readabilityToMarkdown(html)) },
    { method: "trafilatura", run: () => runTrafilatura(url, ctx) },
    { method: "lynx", run: () => runLynx(url, ctx) },
    { method: "jina", run: () => runJina(url, ctx) },
    { method: "browser", run: () => runBrowser(url, ctx) },
  ];

  let lowQuality: { content: string; method: string } | null = null;
  for (const { method, run } of runners) {
    ctx.signal?.throwIfAborted();
    try {
      const rendered = await run();
      if (!rendered) continue;
      const content = stripDataUriImages(rendered);
      if (content.trim().length <= 100) continue;
      if (!isLowQualityOutput(content)) return { content, ok: true, method };
      lowQuality ??= { content, method };
    } catch {
      ctx.signal?.throwIfAborted();
    }
  }

  if (lowQuality) return { content: lowQuality.content, ok: true, method: lowQuality.method };
  return { content: "", ok: false, method: "none" };
}

/** In-process article extraction with Readability, then Turndown. */
export function readabilityToMarkdown(html: string): string | null {
  const document = parseDocument(html);
  const article = new Readability(document as unknown as Document).parse();
  if (!article?.content) return null;
  return htmlToBasicMarkdown(article.content);
}

async function runTrafilatura(url: string, ctx: FetchContext): Promise<string | null> {
  if (!ctx.config.externalReaders || !ctx.exec) return null;
  if (!(await commandAvailable("trafilatura", ctx.exec))) return null;
  const result = await ctx.exec("trafilatura", ["-u", url, "--output-format", "markdown"], {
    signal: ctx.signal,
    timeout: ctx.timeoutMs,
  });
  return result.code === 0 ? result.stdout : null;
}

async function runLynx(url: string, ctx: FetchContext): Promise<string | null> {
  if (!ctx.config.externalReaders || !ctx.exec) return null;
  if (!(await commandAvailable("lynx", ctx.exec))) return null;
  const result = await ctx.exec("lynx", ["-dump", "-nolist", "-width", "250", url], {
    signal: ctx.signal,
    timeout: ctx.timeoutMs,
  });
  return result.code === 0 ? result.stdout : null;
}

/** Render the URL in a headless browser, then extract the live DOM with Readability. */
async function runBrowser(url: string, ctx: FetchContext): Promise<string | null> {
  if (!ctx.renderPage) return null;
  const rendered = await ctx.renderPage(url, { signal: ctx.signal, timeoutMs: ctx.timeoutMs });
  if (rendered.status < 200 || rendered.status >= 300) return null;
  return readabilityToMarkdown(rendered.html);
}

async function runJina(url: string, ctx: FetchContext): Promise<string | null> {
  const apiKey = process.env.JINA_API_KEY;
  if (!ctx.config.remoteFallbacks && !apiKey) return null;

  const headers: Record<string, string> = { Accept: "text/markdown", "X-No-Cache": "true" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await ctx.fetch(`https://r.jina.ai/${url}`, {
    headers,
    signal: withHardTimeout(ctx.signal, Math.min(ctx.timeoutMs, REMOTE_READER_MAX_MS)),
  });
  if (!response.ok) return null;

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > JINA_MAX_BYTES) return null;

  const body = await response.text();
  const start = body.indexOf(JINA_MARKER);
  if (start < 0) return null;
  const content = body.slice(start + JINA_MARKER.length).trim();
  if (
    content.length < 100 ||
    content.startsWith("Loading...") ||
    content.startsWith("Please enable JavaScript")
  ) {
    return null;
  }
  return content;
}

const commandCache = new Map<string, Promise<boolean>>();

/** Detect a command on `PATH` once per process, via `which`/`where`. */
function commandAvailable(command: string, exec: ExecFn): Promise<boolean> {
  let cached = commandCache.get(command);
  if (!cached) {
    const locator = process.platform === "win32" ? "where" : "which";
    cached = exec(locator, [command])
      .then((result) => result.code === 0)
      .catch(() => false);
    commandCache.set(command, cached);
  }
  return cached;
}

/** Check whether content looks like HTML from its leading tag. */
export function looksLikeHtml(content: string): boolean {
  const trimmed = content.trimStart().slice(0, 16).toLowerCase();
  return (
    trimmed.startsWith("<!doctype") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<head") ||
    trimmed.startsWith("<body")
  );
}

/** Heuristic for JS-gated or navigation-heavy reader output. */
export function isLowQualityOutput(content: string): boolean {
  const lower = content.toLowerCase();
  const jsGated = [
    "enable javascript",
    "javascript required",
    "turn on javascript",
    "please enable javascript",
    "browser not supported",
  ];
  if (content.length < 1024 && jsGated.some((token) => lower.includes(token))) return true;

  const lines = content.split("\n").filter((line) => line.trim());
  const shortLines = lines.filter((line) => line.trim().length < 40);
  return lines.length > 10 && shortLines.length / lines.length > 0.7;
}

/**
 * Markdown image whose destination is an inline `data:` URI. The label allows
 * backslash escapes; the scheme is matched case-insensitively, the destination
 * may be bare or `<…>`-wrapped, and an optional title is consumed.
 */
const DATA_URI_IMAGE_RE =
  /!\[((?:\\.|[^\\\]])*)\]\(\s*(?:<data:[^>]*>|data:[^)\s]*)(?:\s+(?:"(?:\\.|[^\\"])*"|'(?:\\.|[^\\'])*'|\((?:\\.|[^\\)])*\)))?\s*\)/gi;

/** Drop inline `data:` image payloads, keeping any alt text. */
export function stripDataUriImages(markdown: string): string {
  return markdown.replace(DATA_URI_IMAGE_RE, (_match, alt: string) =>
    alt.trim() ? `![${alt}]` : "",
  );
}
