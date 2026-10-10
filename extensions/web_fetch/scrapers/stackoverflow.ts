// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { htmlToBasicMarkdown } from "../markdown";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatIsoDate, parseJson } from "./types";

interface SOQuestion {
  title: string;
  body: string;
  score: number;
  owner: { display_name: string };
  creation_date: number;
  tags: string[];
  answer_count: number;
  is_answered: boolean;
}

interface SOAnswer {
  body: string;
  score: number;
  is_accepted: boolean;
  owner: { display_name: string };
}

const STANDALONE_SE_SITES: Record<string, string> = {
  "stackoverflow.com": "stackoverflow",
  "superuser.com": "superuser",
  "serverfault.com": "serverfault",
  "askubuntu.com": "askubuntu",
  "mathoverflow.net": "mathoverflow",
  "stackapps.com": "stackapps",
};

/** Map a Stack Exchange hostname to its API site parameter. Exported for tests. */
export function getSiteParam(hostname: string): string | null {
  const host = hostname.replace(/^www\./, "");
  if (STANDALONE_SE_SITES[host]) return STANDALONE_SE_SITES[host]!;
  const match = host.match(/^([a-z0-9-]+)\.stackexchange\.com$/);
  return match ? match[1]! : null;
}

/** Handle Stack Exchange network URLs via the API. */
export const handleStackOverflow: SpecialHandler = async (
  url,
  ctx,
): Promise<RenderResult | null> => {
  try {
    const parsed = new URL(url);
    const site = getSiteParam(parsed.hostname);
    if (!site) return null;

    const questionId = parsed.pathname.match(/\/questions\/(\d+)/)?.[1];
    if (!questionId) return null;

    const fetchedAt = new Date().toISOString();
    const qResult = await ctx.loadPage(
      `https://api.stackexchange.com/2.3/questions/${questionId}?order=desc&sort=votes&site=${site}&filter=withbody`,
      { signal: ctx.signal },
    );
    if (!qResult.ok) return null;
    const qData = parseJson<{ items: SOQuestion[] }>(qResult.content);
    if (!qData?.items?.length) return null;
    const question = qData.items[0]!;

    let md = `# ${question.title}\n\n`;
    md += `**Score:** ${question.score} · **Answers:** ${question.answer_count}`;
    md += question.is_answered ? " (Answered)" : "";
    md += `\n**Tags:** ${question.tags.join(", ")}\n`;
    md += `**Asked by:** ${question.owner.display_name} · ${formatIsoDate(question.creation_date * 1000)}\n\n`;
    md += `---\n\n## Question\n\n${await htmlToBasicMarkdown(question.body)}\n\n`;

    const aResult = await ctx.loadPage(
      `https://api.stackexchange.com/2.3/questions/${questionId}/answers?order=desc&sort=votes&site=${site}&filter=withbody`,
      { signal: ctx.signal },
    );
    if (aResult.ok) {
      const aData = parseJson<{ items: SOAnswer[] }>(aResult.content);
      if (aData?.items?.length) {
        md += `---\n\n## Answers\n\n`;
        for (const answer of aData.items.slice(0, 5)) {
          md += `### Score: ${answer.score}${answer.is_accepted ? " (Accepted)" : ""} · by ${answer.owner.display_name}\n\n`;
          md += `${await htmlToBasicMarkdown(answer.body)}\n\n---\n\n`;
        }
      }
    }

    return buildResult(md, {
      url,
      method: "stackexchange",
      fetchedAt,
      notes: [`Fetched via Stack Exchange API (site=${site})`],
    });
  } catch {
    return null;
  }
};
