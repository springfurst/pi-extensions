// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { parseXmlDocument } from "../../lib/dom";
import { decodeHtmlEntities } from "../../lib/format";

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
  return decodeHtmlEntities(text)
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
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
