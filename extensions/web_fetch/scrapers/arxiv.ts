// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { parseXmlDocument } from "../../../lib/dom";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult } from "./types";

/** Handle arXiv URLs via the Atom API. Metadata and abstract only — no PDF pipeline. */
export const handleArxiv: SpecialHandler = async (url, ctx): Promise<RenderResult | null> => {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "arxiv.org") return null;

    const match = parsed.pathname.match(/\/(abs|pdf)\/(.+?)(?:\.pdf)?$/);
    if (!match) return null;
    const paperId = match[2]!;
    const fetchedAt = new Date().toISOString();

    const result = await ctx.loadPage(`https://export.arxiv.org/api/query?id_list=${paperId}`, {
      signal: ctx.signal,
    });
    if (!result.ok) return null;

    const entry = parseXmlDocument(result.content).querySelector("entry");
    if (!entry) return null;

    const title = entry.querySelector("title")?.textContent?.trim()?.replace(/\s+/g, " ");
    const summary = entry.querySelector("summary")?.textContent?.trim();
    const authors = Array.from(entry.querySelectorAll("author name"))
      .map((node) => node.textContent?.trim())
      .filter((name): name is string => Boolean(name));
    const published = entry.querySelector("published")?.textContent?.trim()?.split("T")[0];
    const categories = Array.from(entry.querySelectorAll("category"))
      .map((node) => node.getAttribute("term"))
      .filter((term): term is string => Boolean(term));

    let md = `# ${title || "arXiv Paper"}\n\n`;
    if (authors.length) md += `**Authors:** ${authors.join(", ")}\n`;
    if (published) md += `**Published:** ${published}\n`;
    if (categories.length) md += `**Categories:** ${categories.join(", ")}\n`;
    md += `**arXiv:** ${paperId}\n\n---\n\n## Abstract\n\n${summary || "No abstract available."}\n`;

    return buildResult(md, {
      url,
      method: "arxiv",
      fetchedAt,
      notes: ["Fetched via arXiv API"],
    });
  } catch {
    return null;
  }
};
