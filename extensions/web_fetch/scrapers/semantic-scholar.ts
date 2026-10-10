// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { formatNumber } from "../../../lib/format";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, parseJson } from "./types";

interface SemanticScholarPaper {
  paperId: string;
  title: string;
  abstract?: string;
  authors?: Array<{ name: string }>;
  year?: number;
  citationCount?: number;
  referenceCount?: number;
  fieldsOfStudy?: string[];
  journal?: { name: string };
  externalIds?: { DOI?: string; ArXiv?: string; PubMed?: string };
  tldr?: { text: string };
  openAccessPdf?: { url: string };
}

/** Extract a 40-character Semantic Scholar paper id. Exported for tests. */
export function extractPaperId(url: string): string | null {
  const patterns = [
    /semanticscholar\.org\/paper\/[^/]+\/([a-f0-9]{40})/i,
    /semanticscholar\.org\/paper\/([a-f0-9]{40})/i,
    /api\.semanticscholar\.org\/.*\/paper\/([a-f0-9]{40})/i,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Handle Semantic Scholar paper URLs via the Graph API. */
export const handleSemanticScholar: SpecialHandler = async (
  url,
  ctx,
): Promise<RenderResult | null> => {
  if (!url.includes("semanticscholar.org")) return null;
  const paperId = extractPaperId(url);
  if (!paperId) return null;

  const fields = [
    "title",
    "abstract",
    "authors",
    "year",
    "citationCount",
    "referenceCount",
    "fieldsOfStudy",
    "journal",
    "externalIds",
    "tldr",
    "openAccessPdf",
  ].join(",");

  const result = await ctx.loadPage(
    `https://api.semanticscholar.org/graph/v1/paper/${paperId}?fields=${fields}`,
    { signal: ctx.signal },
  );
  if (!result.ok || !result.content) return null;
  const paper = parseJson<SemanticScholarPaper>(result.content);
  if (!paper) return null;

  const sections: string[] = [`# ${paper.title || "Untitled"}`, ""];
  if (paper.authors?.length)
    sections.push(`**Authors:** ${paper.authors.map((author) => author.name).join(", ")}`, "");

  const metadata: string[] = [];
  if (paper.year) metadata.push(`Year: ${paper.year}`);
  if (paper.journal?.name) metadata.push(`Venue: ${paper.journal.name}`);
  if (paper.citationCount !== undefined)
    metadata.push(`Citations: ${formatNumber(paper.citationCount)}`);
  if (paper.referenceCount !== undefined)
    metadata.push(`References: ${formatNumber(paper.referenceCount)}`);
  if (metadata.length > 0) sections.push(metadata.join(" • "), "");
  if (paper.fieldsOfStudy?.length)
    sections.push(`**Fields:** ${paper.fieldsOfStudy.join(", ")}`, "");
  if (paper.tldr?.text) sections.push("## TL;DR", "", paper.tldr.text, "");
  if (paper.abstract) sections.push("## Abstract", "", paper.abstract, "");

  const links: string[] = [];
  if (paper.openAccessPdf?.url) links.push(`[PDF](${paper.openAccessPdf.url})`);
  if (paper.externalIds?.ArXiv)
    links.push(`[arXiv](https://arxiv.org/abs/${paper.externalIds.ArXiv})`);
  if (paper.externalIds?.DOI) links.push(`[DOI](https://doi.org/${paper.externalIds.DOI})`);
  if (paper.externalIds?.PubMed) {
    links.push(`[PubMed](https://pubmed.ncbi.nlm.nih.gov/${paper.externalIds.PubMed}/)`);
  }
  links.push(`[Semantic Scholar](https://www.semanticscholar.org/paper/${paper.paperId})`);
  sections.push("## Links", "", links.join(" • "), "");

  return buildResult(sections.join("\n"), {
    url,
    finalUrl: result.finalUrl,
    method: "semantic-scholar",
    fetchedAt: new Date().toISOString(),
  });
};
