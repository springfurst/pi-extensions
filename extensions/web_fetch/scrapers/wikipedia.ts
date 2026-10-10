// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { parseDocument } from "../../../lib/dom";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, parseJson } from "./types";

const SKIP_SECTIONS = ["References", "External links", "See also", "Notes", "Further reading"];

/** Handle Wikipedia URLs via the REST API. */
export const handleWikipedia: SpecialHandler = async (url, ctx): Promise<RenderResult | null> => {
  try {
    const parsed = new URL(url);
    const wikiMatch = parsed.hostname.match(/^(\w+)\.wikipedia\.org$/);
    if (!wikiMatch) return null;
    const lang = wikiMatch[1]!;
    const titleMatch = parsed.pathname.match(/\/wiki\/(.+)/);
    if (!titleMatch) return null;
    const title = decodeURIComponent(titleMatch[1]!);
    const fetchedAt = new Date().toISOString();

    let md = "";
    const summaryResult = await ctx.loadPage(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { signal: ctx.signal },
    );
    if (summaryResult.ok) {
      const summary = parseJson<{ title: string; description?: string; extract: string }>(
        summaryResult.content,
      );
      if (summary) {
        md = `# ${summary.title}\n\n`;
        if (summary.description) md += `*${summary.description}*\n\n`;
        md += `${summary.extract}\n\n---\n\n`;
      }
    }

    const contentResult = await ctx.loadPage(
      `https://${lang}.wikipedia.org/api/rest_v1/page/mobile-html/${encodeURIComponent(title)}`,
      { signal: ctx.signal },
    );
    if (contentResult.ok) {
      const document = parseDocument(contentResult.content);
      for (const section of Array.from(document.querySelectorAll("section"))) {
        const heading = section.querySelector("h2, h3, h4");
        const headingText = heading?.textContent?.trim();
        if (headingText && SKIP_SECTIONS.includes(headingText)) continue;
        if (headingText) {
          const level = heading?.tagName === "H2" ? "##" : "###";
          md += `${level} ${headingText}\n\n`;
        }
        for (const paragraph of Array.from(section.querySelectorAll("p"))) {
          const text = paragraph.textContent?.trim();
          if (text && text.length > 20) md += `${text}\n\n`;
        }
      }
    }

    if (!md) return null;
    return buildResult(md, {
      url,
      method: "wikipedia",
      fetchedAt,
      notes: ["Fetched via Wikipedia API"],
    });
  } catch {
    return null;
  }
};
