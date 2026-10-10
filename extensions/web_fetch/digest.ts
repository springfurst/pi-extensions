// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { parseXmlDocument } from "../../lib/dom";
import { looksLikeHtml } from "./extract";
import type { FetchContext } from "./types";

/**
 * Build `llms.txt`/`llms.md` candidates scoped to the requested URL: the
 * site root, then each ancestor path from deepest to shallowest.
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

/** Try `url.md` variants following the llms.txt convention. */
export async function tryMdSuffix(url: string, ctx: FetchContext): Promise<string | null> {
  const candidates: string[] = [];
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    if (pathname.endsWith("/")) {
      candidates.push(`${parsed.origin}${pathname}index.html.md`);
    } else if (pathname.includes(".")) {
      candidates.push(`${parsed.origin}${pathname}.md`);
    } else {
      candidates.push(`${parsed.origin}${pathname}.md`);
    }
  } catch {
    return null;
  }

  for (const candidate of candidates) {
    if (ctx.signal?.aborted) return null;
    const result = await ctx.loadPage(candidate, { signal: ctx.signal });
    if (result.ok && result.content.trim().length > 100 && !looksLikeHtml(result.content)) {
      return result.content;
    }
  }
  return null;
}

/** Try `llms.txt`/`llms.md` endpoints scoped to the URL. */
export async function tryLlmEndpoints(
  url: string,
  ctx: FetchContext,
): Promise<{ content: string; endpoint: string } | null> {
  const endpoints = buildLlmEndpointCandidates(url);
  for (const endpoint of endpoints) {
    if (ctx.signal?.aborted) return null;
    const result = await ctx.loadPage(endpoint, {
      signal: ctx.signal,
      timeoutSeconds: Math.min(ctx.timeoutMs / 1000, 5),
    });
    if (result.ok && result.content.trim().length > 100 && !looksLikeHtml(result.content)) {
      return { content: result.content, endpoint };
    }
  }
  return null;
}

/** Request markdown/plain via content negotiation. */
export async function tryContentNegotiation(
  url: string,
  ctx: FetchContext,
): Promise<{ content: string; type: string } | null> {
  if (ctx.signal?.aborted) return null;
  const result = await ctx.loadPage(url, {
    signal: ctx.signal,
    headers: { Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8" },
  });
  if (!result.ok) return null;
  const mime = result.contentType;
  if ((mime.includes("markdown") || mime === "text/plain") && !looksLikeHtml(result.content)) {
    return { content: result.content, type: result.contentType };
  }
  return null;
}

function getHtmlAttribute(tag: string, attribute: string): string | null {
  const pattern = new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i");
  const match = tag.match(pattern);
  if (!match) return null;
  return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/** Extract a bounded `<head>` prefix to avoid parsing the whole page. */
function extractHeadHtml(html: string): string {
  const SCAN_LIMIT = 256 * 1024;
  const window = html.length > SCAN_LIMIT ? html.slice(0, SCAN_LIMIT) : html;
  const headStart = window.search(/<head[\s>]/i);
  if (headStart === -1) return html.slice(0, 32 * 1024);

  const headTagEnd = html.indexOf(">", headStart);
  if (headTagEnd === -1 || headTagEnd - headStart > 4096) {
    return html.slice(headStart, headStart + 32 * 1024);
  }

  const tail = html.slice(headTagEnd + 1, headTagEnd + 1 + 128 * 1024);
  const relativeEnd = tail.search(/<\/head\s*>/i);
  if (relativeEnd === -1) return html.slice(headStart, headTagEnd + 1 + tail.length);
  return html.slice(headStart, headTagEnd + 1 + relativeEnd + 7);
}

/** Parse `<link rel="alternate">` targets from the document head. */
export function parseAlternateLinks(html: string, pageUrl: string): string[] {
  const links: string[] = [];
  try {
    const pagePath = new URL(pageUrl).pathname;
    const headHtml = extractHeadHtml(html);
    const linkTags = headHtml.match(/<link\b[^>]*>/gi) ?? [];

    for (const tag of linkTags) {
      const rel = getHtmlAttribute(tag, "rel")?.toLowerCase() ?? "";
      const relTokens = rel.split(/\s+/).filter(Boolean);
      if (!relTokens.includes("alternate")) continue;

      const href = getHtmlAttribute(tag, "href");
      const type = getHtmlAttribute(tag, "type")?.toLowerCase() ?? "";
      if (!href) continue;

      // Skip site-wide feeds.
      if (
        href.includes("RecentChanges") ||
        href.includes("Special:") ||
        href.includes("/feed/") ||
        href.includes("action=feed")
      ) {
        continue;
      }

      if (type.includes("markdown")) {
        links.push(href);
      } else if (
        (type.includes("rss") || type.includes("atom") || type.includes("feed")) &&
        (href.includes(pagePath) || href.includes("comments"))
      ) {
        links.push(href);
      }
    }
  } catch {
    // Malformed page URL — no alternates.
  }
  return links;
}

function cleanFeedText(text: string): string {
  return text
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, "")
    .trim();
}

/** Parse an RSS or Atom feed into markdown, capped at `maxItems` entries. */
export function parseFeedToMarkdown(content: string, maxItems = 10): string {
  try {
    const doc = parseXmlDocument(content);

    const channel = doc.querySelector("channel");
    if (channel) {
      const title = cleanFeedText(channel.querySelector("title")?.textContent ?? "RSS Feed");
      const items = Array.from(channel.querySelectorAll("item")).slice(0, maxItems);

      let md = `# ${title}\n\n`;
      for (const item of items) {
        const itemTitle = cleanFeedText(item.querySelector("title")?.textContent ?? "Untitled");
        const link = cleanFeedText(item.querySelector("link")?.textContent ?? "");
        const pubDate = cleanFeedText(item.querySelector("pubDate")?.textContent ?? "");
        const desc = cleanFeedText(item.querySelector("description")?.textContent ?? "");

        md += `## ${itemTitle}\n`;
        if (pubDate) md += `*${pubDate}*\n\n`;
        if (desc) md += `${desc.slice(0, 500)}${desc.length > 500 ? "..." : ""}\n\n`;
        if (link) md += `[Read more](${link})\n\n`;
        md += "---\n\n";
      }
      return md;
    }

    const feed = doc.querySelector("feed");
    if (feed) {
      const title = cleanFeedText(feed.querySelector("title")?.textContent ?? "Atom Feed");
      const entries = Array.from(feed.querySelectorAll("entry")).slice(0, maxItems);

      let md = `# ${title}\n\n`;
      for (const entry of entries) {
        const entryTitle = cleanFeedText(entry.querySelector("title")?.textContent ?? "Untitled");
        const link = entry.querySelector("link")?.getAttribute("href") ?? "";
        const updated = cleanFeedText(entry.querySelector("updated")?.textContent ?? "");
        const summary = cleanFeedText(
          entry.querySelector("summary")?.textContent ??
            entry.querySelector("content")?.textContent ??
            "",
        );

        md += `## ${entryTitle}\n`;
        if (updated) md += `*${updated}*\n\n`;
        if (summary) md += `${summary.slice(0, 500)}${summary.length > 500 ? "..." : ""}\n\n`;
        if (link) md += `[Read more](${link})\n\n`;
        md += "---\n\n";
      }
      return md;
    }
  } catch {
    // Fall through to the raw content.
  }
  return content;
}
