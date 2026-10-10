import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatIsoDate, parseJson } from "./types";

interface RedditPost {
  title: string;
  selftext: string;
  author: string;
  score: number;
  num_comments: number;
  created_utc: number;
  subreddit: string;
  url: string;
  is_self: boolean;
}

interface RedditComment {
  body: string;
  author: string;
  score: number;
}

/** Handle Reddit URLs via the JSON API. */
export const handleReddit: SpecialHandler = async (url, ctx): Promise<RenderResult | null> => {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("reddit.com")) return null;
    const fetchedAt = new Date().toISOString();

    let jsonUrl = `${url.replace(/\/$/, "")}.json`;
    if (parsed.search)
      jsonUrl = `${url.replace(/\/$/, "").replace(parsed.search, "")}.json${parsed.search}`;

    const result = await ctx.loadPage(jsonUrl, { signal: ctx.signal });
    if (!result.ok) return null;
    const data = parseJson<unknown>(result.content);
    if (!data) return null;

    let md = "";
    if (Array.isArray(data) && data.length >= 1) {
      const postData = (data[0] as { data?: { children?: Array<{ data: RedditPost }> } })?.data
        ?.children?.[0]?.data;
      if (postData) {
        md = `# ${postData.title}\n\n`;
        md += `**r/${postData.subreddit}** · u/${postData.author} · ${postData.score} points · ${postData.num_comments} comments\n`;
        md += `*${formatIsoDate(postData.created_utc * 1000)}*\n\n`;
        if (postData.is_self && postData.selftext) md += `---\n\n${postData.selftext}\n\n`;
        else if (!postData.is_self) md += `**Link:** ${postData.url}\n\n`;

        const children = (
          data[1] as { data?: { children?: Array<{ kind: string; data: RedditComment }> } }
        )?.data?.children;
        if (children) {
          md += `---\n\n## Top Comments\n\n`;
          for (const comment of children.filter((child) => child.kind === "t1").slice(0, 10)) {
            md += `### u/${comment.data.author} · ${comment.data.score} points\n\n`;
            md += `${comment.data.body}\n\n---\n\n`;
          }
        }
      }
    } else if ((data as { data?: { children?: Array<{ data: RedditPost }> } })?.data?.children) {
      const posts = (
        data as { data: { children: Array<{ data: RedditPost }> } }
      ).data.children.slice(0, 20);
      const subreddit = posts[0]?.data?.subreddit;
      md = `# r/${subreddit || "Reddit"}\n\n`;
      for (const { data: post } of posts) {
        md += `- **${post.title}** (${post.score} pts, ${post.num_comments} comments)\n  by u/${post.author}\n\n`;
      }
    }

    if (!md) return null;
    return buildResult(md, {
      url,
      method: "reddit",
      fetchedAt,
      notes: ["Fetched via Reddit JSON API"],
    });
  } catch {
    return null;
  }
};
