import { formatNumber } from "../../../lib/format";
import { looksLikeHtml } from "../extract";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, parseJson } from "./types";

/** Handle crates.io URLs via the API. */
export const handleCratesIo: SpecialHandler = async (url, ctx): Promise<RenderResult | null> => {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "crates.io" && parsed.hostname !== "www.crates.io") return null;

    const match = parsed.pathname.match(/^\/crates\/([^/]+)/);
    if (!match) return null;
    const crateName = decodeURIComponent(match[1]!);
    const fetchedAt = new Date().toISOString();

    const result = await ctx.loadPage(`https://crates.io/api/v1/crates/${crateName}`, {
      signal: ctx.signal,
    });
    if (!result.ok) return null;

    const data = parseJson<{
      crate: {
        name: string;
        description: string | null;
        downloads: number;
        recent_downloads: number;
        max_version: string;
        repository: string | null;
        homepage: string | null;
        documentation: string | null;
        categories: string[];
        keywords: string[];
      };
      versions: Array<{
        num: string;
        downloads: number;
        created_at: string;
        license: string | null;
        rust_version: string | null;
      }>;
    }>(result.content);
    if (!data) return null;

    const crate = data.crate;
    const latestVersion = data.versions?.[0];
    let md = `# ${crate.name}\n\n`;
    if (crate.description) md += `${crate.description}\n\n`;
    md += `**Latest:** ${crate.max_version}`;
    if (latestVersion?.license) md += ` · **License:** ${latestVersion.license}`;
    if (latestVersion?.rust_version) md += ` · **MSRV:** ${latestVersion.rust_version}`;
    md += "\n";
    md += `**Downloads:** ${formatNumber(crate.downloads)} total · ${formatNumber(crate.recent_downloads)} recent\n\n`;
    if (crate.repository) md += `**Repository:** ${crate.repository}\n`;
    if (crate.homepage && crate.homepage !== crate.repository)
      md += `**Homepage:** ${crate.homepage}\n`;
    if (crate.documentation) md += `**Docs:** ${crate.documentation}\n`;
    if (crate.keywords?.length) md += `**Keywords:** ${crate.keywords.join(", ")}\n`;
    if (crate.categories?.length) md += `**Categories:** ${crate.categories.join(", ")}\n`;

    if (data.versions?.length > 0) {
      md += `\n## Recent Versions\n\n`;
      for (const version of data.versions.slice(0, 5)) {
        md += `- **${version.num}** (${version.created_at.split("T")[0]}) - ${formatNumber(version.downloads)} downloads\n`;
      }
    }

    const readmeResult = await ctx.loadPage(
      `https://docs.rs/crate/${crateName}/${crate.max_version}/source/README.md`,
      { signal: ctx.signal, timeoutSeconds: Math.min(ctx.timeoutMs / 1000, 5) },
    );
    if (
      readmeResult.ok &&
      readmeResult.content.length > 100 &&
      !looksLikeHtml(readmeResult.content)
    ) {
      md += `\n---\n\n## README\n\n${readmeResult.content}\n`;
    }

    return buildResult(md, {
      url,
      method: "crates.io",
      fetchedAt,
      notes: ["Fetched via crates.io API"],
    });
  } catch {
    return null;
  }
};
