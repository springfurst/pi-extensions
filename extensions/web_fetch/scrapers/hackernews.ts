// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { decodeHtmlEntities } from "../../../lib/format";
import type { FetchContext, RenderResult, SpecialHandler } from "./types";
import { buildResult, formatIsoDate, mapWithConcurrency, parseJson } from "./types";

/** Comment threads rendered at once; each fetches up to 10 replies in parallel. */
const HN_CHILD_THREAD_CONCURRENCY = 2;
const API_BASE = "https://hacker-news.firebaseio.com/v0";

interface HNItem {
  id: number;
  deleted?: boolean;
  by?: string;
  time?: number;
  text?: string;
  dead?: boolean;
  kids?: number[];
  url?: string;
  score?: number;
  title?: string;
  descendants?: number;
}

async function fetchItem(id: number, ctx: FetchContext): Promise<HNItem | null> {
  const { content, ok } = await ctx.loadPage(`${API_BASE}/item/${id}.json`, { signal: ctx.signal });
  if (!ok) return null;
  return parseJson<HNItem>(content) ?? null;
}

async function fetchItems(ids: number[], ctx: FetchContext, limit = 20): Promise<HNItem[]> {
  const results = await Promise.all(ids.slice(0, limit).map((id) => fetchItem(id, ctx)));
  return results.filter((item): item is HNItem => item !== null && !item.deleted && !item.dead);
}

/** Strip HN's limited HTML to plain text/markdown. */
export function decodeHNText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<p>/g, "\n\n")
      .replace(/<\/p>/g, "")
      .replace(/<pre><code>/g, "\n```\n")
      .replace(/<\/code><\/pre>/g, "\n```\n")
      .replace(/<code>/g, "`")
      .replace(/<\/code>/g, "`")
      .replace(/<i>/g, "*")
      .replace(/<\/i>/g, "*")
      .replace(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g, "[$2]($1)")
      .replace(/<[^>]+>/g, ""),
  ).trim();
}

function formatTimestamp(unixTime: number): string {
  const date = new Date(unixTime * 1000);
  const diff = Date.now() - date.getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  if (days > 7) return formatIsoDate(unixTime * 1000);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return `${Math.floor(diff / (1000 * 60))}m ago`;
}

async function renderStory(item: HNItem, ctx: FetchContext, depth = 0): Promise<string> {
  let output = "";
  if (depth === 0) {
    output += `# ${item.title}\n\n`;
    if (item.url) output += `**URL:** ${item.url}\n\n`;
    output += `**Posted by:** ${item.by} | **Score:** ${item.score ?? 0} | **Time:** ${formatTimestamp(item.time ?? 0)}`;
    if (item.descendants) output += ` | **Comments:** ${item.descendants}`;
    output += "\n\n";
  }
  if (item.text) output += `${decodeHNText(item.text)}\n\n`;

  if (item.kids && item.kids.length > 0 && depth < 2) {
    const topComments = item.kids.slice(0, depth === 0 ? 20 : 10);
    const comments = await fetchItems(topComments, ctx, topComments.length);
    if (comments.length > 0) {
      if (depth === 0) output += "---\n\n## Comments\n\n";
      const childOutputs = await mapWithConcurrency(
        comments,
        HN_CHILD_THREAD_CONCURRENCY,
        (comment) =>
          comment.kids && comment.kids.length > 0 && depth < 1
            ? renderStory(comment, ctx, depth + 1)
            : Promise.resolve(""),
        ctx.signal,
      );
      const indent = "  ".repeat(depth);
      for (let i = 0; i < comments.length; i++) {
        const comment = comments[i]!;
        output += `${indent}**${comment.by}** (${formatTimestamp(comment.time ?? 0)})`;
        if (comment.score !== undefined) output += ` [${comment.score}]`;
        output += "\n";
        if (comment.text) {
          output += `${decodeHNText(comment.text)
            .split("\n")
            .map((line) => `${indent}${line}`)
            .join("\n")}\n\n`;
        }
        output += childOutputs[i] ?? "";
      }
    }
  }
  return output;
}

async function renderListing(ids: number[], title: string, ctx: FetchContext): Promise<string> {
  let output = `# ${title}\n\n`;
  const stories = await fetchItems(ids, ctx, 20);
  for (let i = 0; i < stories.length; i++) {
    const story = stories[i]!;
    output += `${i + 1}. **${story.title}**\n`;
    if (story.url) output += `   ${story.url}\n`;
    output += `   ${story.score ?? 0} points by ${story.by} | ${formatTimestamp(story.time ?? 0)}`;
    if (story.descendants) output += ` | ${story.descendants} comments`;
    output += `\n   https://news.ycombinator.com/item?id=${story.id}\n\n`;
  }
  return output;
}

/** Handle Hacker News item and listing URLs via the Firebase API. */
export const handleHackerNews: SpecialHandler = async (url, ctx): Promise<RenderResult | null> => {
  const parsed = new URL(url);
  if (!parsed.hostname.includes("news.ycombinator.com")) return null;

  const notes: string[] = [];
  const fetchedAt = new Date().toISOString();

  try {
    let content = "";
    const itemId = parsed.searchParams.get("id");
    if (itemId) {
      const item = await fetchItem(parseInt(itemId, 10), ctx);
      if (!item) return null;
      content = await renderStory(item, ctx, 0);
      notes.push(`Fetched HN item ${itemId} with top-level comments (depth 2)`);
    } else if (parsed.pathname === "/" || parsed.pathname === "/news") {
      const { content: raw, ok } = await ctx.loadPage(`${API_BASE}/topstories.json`, {
        signal: ctx.signal,
      });
      if (!ok) return null;
      const ids = parseJson<number[]>(raw);
      if (!ids) return null;
      content = await renderListing(ids, "Hacker News - Top Stories", ctx);
      notes.push("Fetched top 20 stories from HN front page");
    } else if (parsed.pathname === "/newest") {
      const { content: raw, ok } = await ctx.loadPage(`${API_BASE}/newstories.json`, {
        signal: ctx.signal,
      });
      if (!ok) return null;
      const ids = parseJson<number[]>(raw);
      if (!ids) return null;
      content = await renderListing(ids, "Hacker News - New Stories", ctx);
      notes.push("Fetched top 20 new stories");
    } else if (parsed.pathname === "/best") {
      const { content: raw, ok } = await ctx.loadPage(`${API_BASE}/beststories.json`, {
        signal: ctx.signal,
      });
      if (!ok) return null;
      const ids = parseJson<number[]>(raw);
      if (!ids) return null;
      content = await renderListing(ids, "Hacker News - Best Stories", ctx);
      notes.push("Fetched top 20 best stories");
    } else {
      return null;
    }

    return buildResult(content, { url, method: "hackernews", fetchedAt, notes });
  } catch {
    return null;
  }
};
