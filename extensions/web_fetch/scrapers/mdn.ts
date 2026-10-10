// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { htmlToBasicMarkdown } from "../markdown";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, parseJson } from "./types";

interface MDNSection {
  type: string;
  value: {
    title?: string;
    content?: string;
    isH3?: boolean;
    code?: string;
    language?: string;
    items?: Array<{ term: string; description: string }>;
    rows?: string[][];
  };
}

interface MDNDoc {
  doc: {
    title: string;
    summary: string;
    mdn_url: string;
    body: MDNSection[];
  };
}

async function convertMDNBody(sections: MDNSection[]): Promise<string> {
  const parts: string[] = [];
  for (const section of sections) {
    const { type, value } = section;
    switch (type) {
      case "prose":
        if (value.content) {
          const markdown = await htmlToBasicMarkdown(value.content);
          if (value.title) parts.push(`${value.isH3 ? "###" : "##"} ${value.title}\n\n${markdown}`);
          else parts.push(markdown);
        }
        break;
      case "browser_compatibility":
        if (value.title) parts.push(`## ${value.title}\n\n(See browser compatibility data at MDN)`);
        break;
      case "specifications":
        if (value.title) parts.push(`## ${value.title}\n\n(See specifications at MDN)`);
        break;
      case "code_example":
        if (value.title) parts.push(`### ${value.title}`);
        if (value.code) parts.push(`\`\`\`${value.language || ""}\n${value.code}\n\`\`\``);
        break;
      case "definition_list":
        for (const item of value.items ?? []) {
          parts.push(`**${item.term}**`, await htmlToBasicMarkdown(item.description));
        }
        break;
      case "table":
        if (value.rows && value.rows.length > 0) {
          const header = (
            await Promise.all(value.rows[0]!.map((cell) => htmlToBasicMarkdown(cell)))
          ).join(" | ");
          const separator = value.rows[0]!.map(() => "---").join(" | ");
          parts.push(`| ${header} |`, `| ${separator} |`);
          for (const row of value.rows.slice(1)) {
            parts.push(
              `| ${(await Promise.all(row.map((cell) => htmlToBasicMarkdown(cell)))).join(" | ")} |`,
            );
          }
        }
        break;
    }
  }
  return parts.join("\n\n");
}

/** Handle MDN documentation URLs via the `index.json` API. */
export const handleMDN: SpecialHandler = async (url, ctx): Promise<RenderResult | null> => {
  const urlObj = new URL(url);
  if (!urlObj.hostname.includes("developer.mozilla.org")) return null;
  if (!urlObj.pathname.includes("/docs/")) return null;

  const jsonUrl = url.replace(/\/?$/, "/index.json");
  try {
    const result = await ctx.loadPage(jsonUrl, {
      signal: ctx.signal,
      headers: { Accept: "application/json" },
    });
    if (!result.ok) return null;

    const data = parseJson<MDNDoc>(result.content);
    if (!data?.doc?.title) return null;

    const parts = [`# ${data.doc.title}`];
    if (data.doc.summary) parts.push(await htmlToBasicMarkdown(data.doc.summary));
    if (data.doc.body?.length) parts.push(await convertMDNBody(data.doc.body));

    return buildResult(parts.join("\n\n"), {
      url,
      finalUrl: data.doc.mdn_url || result.finalUrl,
      method: "mdn",
      fetchedAt: new Date().toISOString(),
    });
  } catch {
    return null;
  }
};
