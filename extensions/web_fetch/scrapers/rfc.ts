import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, parseJson } from "./types";

interface RfcMetadata {
  title: string;
  authors?: Array<{ name: string; affiliation?: string }>;
  current_status?: string;
  stream?: string;
  area?: string;
  wg_acronym?: string;
  pub_date?: string;
  page_count?: number;
  abstract?: string;
  keywords?: string[];
  obsoletes?: string[];
  obsoleted_by?: string[];
  updates?: string[];
  updated_by?: string[];
  errata_url?: string;
}

/** Extract the RFC number from a supported URL. Exported for tests. */
export function extractRfcNumber(url: URL): string | null {
  const { hostname, pathname } = url;
  if (hostname === "www.rfc-editor.org" || hostname === "rfc-editor.org") {
    return pathname.match(/\/rfc\/rfc(\d+)(?:\.(?:html|txt|pdf))?$/i)?.[1] ?? null;
  }
  if (hostname === "datatracker.ietf.org") {
    return pathname.match(/\/doc\/(?:html\/)?rfc(\d+)\/?$/i)?.[1] ?? null;
  }
  if (hostname === "tools.ietf.org") {
    return pathname.match(/\/html\/rfc(\d+)$/i)?.[1] ?? null;
  }
  return null;
}

/** Remove RFC page headers/footers introduced by pagination. */
export function cleanRfcText(text: string): string {
  const lines = text.split("\n");
  const cleaned: string[] = [];
  let skipNext = 0;
  for (const line of lines) {
    if (skipNext > 0) {
      skipNext--;
      continue;
    }
    if (line.includes("\f")) {
      skipNext = 3;
      continue;
    }
    if (/^\s*\[Page \d+\]\s*$/.test(line)) continue;
    cleaned.push(line);
  }
  return cleaned.join("\n").replace(/\n{4,}/g, "\n\n\n");
}

/** Handle RFC Editor URLs. */
export const handleRfc: SpecialHandler = async (url, ctx): Promise<RenderResult | null> => {
  try {
    const parsed = new URL(url);
    const rfcNumber = extractRfcNumber(parsed);
    if (!rfcNumber) return null;

    const fetchedAt = new Date().toISOString();
    const notes: string[] = [];
    const [metaResult, textResult] = await Promise.all([
      ctx.loadPage(`https://www.rfc-editor.org/rfc/rfc${rfcNumber}.json`, {
        signal: ctx.signal,
        timeoutSeconds: Math.min(ctx.timeoutMs / 1000, 10),
      }),
      ctx.loadPage(`https://www.rfc-editor.org/rfc/rfc${rfcNumber}.txt`, { signal: ctx.signal }),
    ]);
    if (!textResult.ok) return null;

    const metadata = metaResult.ok ? parseJson<RfcMetadata>(metaResult.content) : undefined;
    if (metadata) notes.push("Metadata from RFC Editor JSON API");

    let md = "";
    if (metadata) {
      md += `# RFC ${rfcNumber}: ${metadata.title}\n\n`;
      if (metadata.authors?.length) {
        md += `**Authors:** ${metadata.authors
          .map((author) =>
            author.affiliation ? `${author.name} (${author.affiliation})` : author.name,
          )
          .join(", ")}\n`;
      }
      if (metadata.pub_date) md += `**Published:** ${metadata.pub_date}\n`;
      if (metadata.current_status) md += `**Status:** ${metadata.current_status}\n`;
      if (metadata.stream) md += `**Stream:** ${metadata.stream}\n`;
      if (metadata.area) md += `**Area:** ${metadata.area}\n`;
      if (metadata.wg_acronym) md += `**Working Group:** ${metadata.wg_acronym}\n`;
      if (metadata.page_count) md += `**Pages:** ${metadata.page_count}\n`;
      if (metadata.obsoletes?.length) md += `**Obsoletes:** ${metadata.obsoletes.join(", ")}\n`;
      if (metadata.obsoleted_by?.length)
        md += `**Obsoleted by:** ${metadata.obsoleted_by.join(", ")}\n`;
      if (metadata.updates?.length) md += `**Updates:** ${metadata.updates.join(", ")}\n`;
      if (metadata.updated_by?.length) md += `**Updated by:** ${metadata.updated_by.join(", ")}\n`;
      if (metadata.keywords?.length) md += `**Keywords:** ${metadata.keywords.join(", ")}\n`;
      if (metadata.errata_url) md += `**Errata:** ${metadata.errata_url}\n`;
      md += "\n";
      if (metadata.abstract) md += `## Abstract\n\n${metadata.abstract}\n\n`;
      md += "---\n\n";
    } else {
      md += `# RFC ${rfcNumber}\n\n`;
      notes.push("Metadata not available, showing plain text only");
    }

    md += `## Full Text\n\n\`\`\`\n${cleanRfcText(textResult.content)}\n\`\`\`\n`;

    return buildResult(md, {
      url,
      finalUrl: `https://www.rfc-editor.org/rfc/rfc${rfcNumber}`,
      method: "rfc",
      fetchedAt,
      notes: notes.length ? notes : ["Fetched from RFC Editor"],
    });
  } catch {
    return null;
  }
};
