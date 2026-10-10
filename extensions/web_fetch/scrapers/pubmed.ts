// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import type { FetchContext, RenderResult, SpecialHandler } from "./types";
import { buildResult, parseJson } from "./types";

const NCBI_HEADERS = {
  Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
};

function withApiKey(url: string): string {
  const key = process.env.NCBI_API_KEY;
  if (!key) return url;
  return `${url}${url.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(key)}`;
}

async function fetchWithRetry(
  requestUrl: string,
  ctx: FetchContext,
  acceptJson: boolean,
): Promise<Awaited<ReturnType<FetchContext["loadPage"]>>> {
  const headers = {
    ...NCBI_HEADERS,
    Accept: acceptJson ? "application/json" : "text/plain, */*;q=0.8",
  };
  let response = await ctx.loadPage(withApiKey(requestUrl), { signal: ctx.signal, headers });
  if (!response.ok) {
    response = await ctx.loadPage(withApiKey(requestUrl), { signal: ctx.signal, headers });
  }
  return response;
}

/** Handle PubMed URLs via NCBI E-utilities. */
export const handlePubMed: SpecialHandler = async (url, ctx): Promise<RenderResult | null> => {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname !== "pubmed.ncbi.nlm.nih.gov" &&
      !(parsed.hostname === "ncbi.nlm.nih.gov" && parsed.pathname.startsWith("/pubmed"))
    ) {
      return null;
    }

    let pmid: string | null = null;
    if (parsed.hostname === "pubmed.ncbi.nlm.nih.gov") {
      pmid = parsed.pathname.match(/\/(\d+)/)?.[1] ?? null;
    } else {
      pmid = parsed.pathname.match(/\/pubmed\/(\d+)/)?.[1] ?? null;
    }
    if (!pmid) return null;

    const fetchedAt = new Date().toISOString();
    const notes: string[] = [];
    const buildFallback = (fallbackNotes: string[]) =>
      buildResult(
        `# PubMed Article\n\n**PMID:** ${pmid}\n\n---\n\n## Abstract\n\nNo abstract available.\n`,
        {
          url,
          method: "pubmed",
          fetchedAt,
          notes: fallbackNotes,
        },
      );

    const summaryResult = await fetchWithRetry(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`,
      ctx,
      true,
    );
    if (!summaryResult.ok) return buildFallback(["Failed to fetch PubMed summary metadata"]);

    const summaryData = parseJson<{
      result?: Record<
        string,
        {
          title?: string;
          authors?: Array<{ name: string }>;
          fulljournalname?: string;
          pubdate?: string;
          volume?: string;
          issue?: string;
          pages?: string;
          elocationid?: string;
          articleids?: Array<{ idtype: string; value: string }>;
        }
      >;
    }>(summaryResult.content);
    if (!summaryData) return buildFallback(["Failed to parse PubMed summary metadata"]);

    const article = summaryData.result?.[pmid];
    if (!article)
      return buildFallback(["PubMed record unavailable from E-utilities summary endpoint"]);

    const abstractResult = await fetchWithRetry(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=abstract&retmode=text`,
      ctx,
      false,
    );
    let abstractText = "";
    if (abstractResult.ok) {
      abstractText = abstractResult.content.trim();
      notes.push("Fetched abstract via NCBI E-utilities");
    }

    let doi = "";
    let pmcid = "";
    for (const id of article.articleids ?? []) {
      if (id.idtype === "doi") doi = id.value;
      if (id.idtype === "pmc") pmcid = id.value;
    }
    if (!doi && article.elocationid) doi = article.elocationid;

    let md = `# ${article.title || "PubMed Article"}\n\n`;
    if (article.authors?.length)
      md += `**Authors:** ${article.authors.map((author) => author.name).join(", ")}\n`;
    if (article.fulljournalname) {
      md += `**Journal:** ${article.fulljournalname}`;
      if (article.pubdate) md += ` (${article.pubdate})`;
      md += "\n";
    }
    const citation: string[] = [];
    if (article.volume) citation.push(`Vol ${article.volume}`);
    if (article.issue) citation.push(`Issue ${article.issue}`);
    if (article.pages) citation.push(`pp ${article.pages}`);
    if (citation.length > 0) md += `**Citation:** ${citation.join(", ")}\n`;
    md += `**PMID:** ${pmid}\n`;
    if (doi) md += `**DOI:** ${doi}\n`;
    if (pmcid) md += `**PMCID:** ${pmcid}\n`;
    md += "\n---\n\n";
    md += abstractText
      ? `## Abstract\n\n${abstractText}\n`
      : `## Abstract\n\nNo abstract available.\n`;

    try {
      const meshResult = await ctx.loadPage(
        withApiKey(
          `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=medline&retmode=text`,
        ),
        {
          signal: ctx.signal,
          timeoutSeconds: Math.min(ctx.timeoutMs / 1000, 5),
          headers: NCBI_HEADERS,
        },
      );
      if (meshResult.ok) {
        const meshTerms = meshResult.content
          .split("\n")
          .filter((line) => line.startsWith("MH  - "))
          .map((line) => line.slice(6).trim());
        if (meshTerms.length > 0) {
          md += `\n## MeSH Terms\n\n`;
          for (const term of meshTerms) md += `- ${term}\n`;
          notes.push("Fetched MeSH terms via NCBI E-utilities");
        }
      }
    } catch {
      // MeSH terms are optional.
    }

    return buildResult(md, {
      url,
      method: "pubmed",
      fetchedAt,
      notes: notes.length > 0 ? notes : ["Fetched via NCBI E-utilities"],
    });
  } catch {
    return null;
  }
};
