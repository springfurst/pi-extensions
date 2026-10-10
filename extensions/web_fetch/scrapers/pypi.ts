// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { formatNumber } from "../../../lib/format";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, parseJson } from "./types";

/** Handle PyPI URLs via the JSON API. */
export const handlePyPI: SpecialHandler = async (url, ctx): Promise<RenderResult | null> => {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "pypi.org" && parsed.hostname !== "www.pypi.org") return null;

    const match = parsed.pathname.match(/^\/project\/([^/]+)/);
    if (!match) return null;
    const packageName = decodeURIComponent(match[1]!);
    const fetchedAt = new Date().toISOString();

    const [result, downloadsResult] = await Promise.all([
      ctx.loadPage(`https://pypi.org/pypi/${packageName}/json`, { signal: ctx.signal }),
      ctx.loadPage(`https://pypistats.org/api/packages/${packageName}/recent`, {
        signal: ctx.signal,
        timeoutSeconds: Math.min(ctx.timeoutMs / 1000, 5),
      }),
    ]);
    if (!result.ok) return null;

    let weeklyDownloads: number | null = null;
    if (downloadsResult.ok) {
      const downloads = parseJson<{ data?: { last_week?: number } }>(downloadsResult.content);
      if (downloads) weeklyDownloads = downloads.data?.last_week ?? null;
    }

    const pkg = parseJson<{
      info: {
        name: string;
        version: string;
        summary?: string;
        description?: string;
        author?: string;
        author_email?: string;
        license?: string;
        home_page?: string;
        project_urls?: Record<string, string>;
        requires_python?: string;
        keywords?: string;
      };
      requires_dist?: string[];
    }>(result.content);
    if (!pkg) return null;

    const info = pkg.info;
    let md = `# ${info.name}\n\n`;
    if (info.summary) md += `${info.summary}\n\n`;
    md += `**Latest:** ${info.version}`;
    if (info.license) md += ` · **License:** ${info.license}`;
    md += "\n";
    if (weeklyDownloads !== null) md += `**Weekly Downloads:** ${formatNumber(weeklyDownloads)}\n`;
    md += "\n";
    if (info.author) {
      md += `**Author:** ${info.author}`;
      if (info.author_email) md += ` <${info.author_email}>`;
      md += "\n";
    }
    if (info.requires_python) md += `**Python:** ${info.requires_python}\n`;
    if (info.home_page) md += `**Homepage:** ${info.home_page}\n`;
    if (info.project_urls && Object.keys(info.project_urls).length > 0) {
      md += "\n**Project URLs:**\n";
      for (const [label, projectUrl] of Object.entries(info.project_urls))
        md += `- ${label}: ${projectUrl}\n`;
    }
    if (info.keywords) md += `\n**Keywords:** ${info.keywords}\n`;

    if (pkg.requires_dist && pkg.requires_dist.length > 0) {
      md += `\n## Dependencies\n\n`;
      for (const dep of pkg.requires_dist) md += `- ${dep}\n`;
    }
    if (info.description) md += `\n---\n\n## Description\n\n${info.description}\n`;

    return buildResult(md, {
      url,
      method: "pypi",
      fetchedAt,
      notes: ["Fetched via PyPI JSON API"],
    });
  } catch {
    return null;
  }
};
