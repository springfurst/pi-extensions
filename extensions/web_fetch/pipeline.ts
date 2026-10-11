// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { formatBytes } from "../../lib/format";
import {
  parseAlternateLinks,
  parseFeedToMarkdown,
  tryContentNegotiation,
  tryLlmEndpoints,
  tryMdSuffix,
} from "./digest";
import { isLowQualityOutput, looksLikeHtml, renderHtmlToText } from "./extract";
import { finalizeOutput } from "./output";
import { specialHandlers } from "./scrapers";
import { repairCollapsedScheme } from "./selector";
import type { FetchContext, RenderResult } from "./types";

export interface RenderUrlOptions {
  /** Return the response body without text shaping. */
  raw: boolean;
  /** Render cap for this call. */
  maxChars: number;
  ctx: FetchContext;
}

/** Run the full `web_fetch` pipeline for one URL. */
export async function renderUrl(url: string, options: RenderUrlOptions): Promise<RenderResult> {
  const { raw, maxChars, ctx } = options;
  const notes: string[] = [];
  const fetchedAt = new Date().toISOString();
  ctx.signal?.throwIfAborted();

  const normalized = normalizeUrl(url);

  const finish = (
    content: string,
    method: string,
    contentType: string,
    resultUrl: string,
    finalUrl: string,
    status?: number,
  ): RenderResult => {
    const output = finalizeOutput(content, maxChars);
    return {
      url: resultUrl,
      finalUrl,
      contentType,
      method,
      status,
      content: output.content,
      fetchedAt,
      truncated: output.truncated,
      notes,
    };
  };

  // Site-specific handlers run before the generic fetch and degrade to it.
  if (!raw) {
    for (const handler of specialHandlers) {
      ctx.signal?.throwIfAborted();
      try {
        const result = await handler(normalized, ctx);
        if (result) {
          const output = finalizeOutput(result.content, maxChars);
          return {
            ...result,
            content: output.content,
            truncated: output.truncated,
          };
        }
      } catch {
        // Additive enhancer: a failure resumes the generic pipeline.
      }
    }
  }

  const response = await ctx.loadPage(normalized, { signal: ctx.signal });
  ctx.signal?.throwIfAborted();

  if (!response.ok) {
    if (response.status) notes.push(`Failed to fetch URL (HTTP ${response.status})`);
    else notes.push("Failed to fetch URL");
    if (response.error) notes.push(`Cause: ${response.error}`);
    return {
      url,
      finalUrl: response.finalUrl || normalized,
      contentType: response.contentType || "unknown",
      method: "failed",
      status: response.status,
      content: "",
      fetchedAt,
      truncated: false,
      notes,
    };
  }

  const { finalUrl, content: rawContent, contentType: mime } = response;
  if (response.truncated) {
    notes.push(
      `Response body exceeded ${formatBytes(ctx.config.maxBytes)} and was cut mid-stream; content is incomplete`,
    );
  }

  if (raw) return finish(rawContent, "raw", mime, url, finalUrl, response.status);
  if (mime.includes("json"))
    return finish(formatJson(rawContent), "json", mime, url, finalUrl, response.status);

  const isXml = mime.includes("xml") && !mime.includes("html");
  const isFeed = mime.includes("rss") || mime.includes("atom") || mime.includes("feed");
  if (isFeed || (isXml && (rawContent.includes("<rss") || rawContent.includes("<feed")))) {
    return finish(parseFeedToMarkdown(rawContent), "feed", mime, url, finalUrl, response.status);
  }

  const isText = mime.includes("text/plain") || mime.includes("text/markdown");
  if (isText && !looksLikeHtml(rawContent))
    return finish(rawContent, "text", mime, url, finalUrl, response.status);

  if (mime.includes("html") || mime.includes("xhtml") || looksLikeHtml(rawContent)) {
    const alternates = parseAlternateLinks(rawContent, finalUrl);

    // 5A: page-specific markdown alternate.
    const markdownAlt = alternates.find((alt) => alt.endsWith(".md") || alt.includes("markdown"));
    if (markdownAlt) {
      const resolved = resolveUrl(markdownAlt, finalUrl);
      const alt = await ctx.loadPage(resolved, { signal: ctx.signal });
      if (alt.ok && alt.content.trim().length > 100 && !looksLikeHtml(alt.content)) {
        notes.push(`Used markdown alternate: ${resolved}`);
        return finish(
          alt.content,
          "alternate-markdown",
          "text/markdown",
          url,
          finalUrl,
          alt.status,
        );
      }
    }

    // 5B: `/path.md` suffix.
    const mdSuffix = await tryMdSuffix(finalUrl, ctx);
    if (mdSuffix) {
      notes.push("Found .md suffix version");
      return finish(mdSuffix, "md-suffix", "text/markdown", url, finalUrl);
    }

    // 5C: content negotiation.
    const negotiated = await tryContentNegotiation(normalized, ctx);
    if (negotiated) {
      notes.push(`Content negotiation returned ${negotiated.type}`);
      return finish(negotiated.content, "content-negotiation", negotiated.type, url, finalUrl);
    }

    // 5D: feed alternates.
    const feedAlternates = alternates.filter(
      (alt) => !alt.endsWith(".md") && !alt.includes("markdown"),
    );
    for (const altUrl of feedAlternates.slice(0, 2)) {
      const resolved = resolveUrl(altUrl, finalUrl);
      const alt = await ctx.loadPage(resolved, { signal: ctx.signal });
      if (alt.ok && alt.content.trim().length > 200) {
        notes.push(`Used feed alternate: ${resolved}`);
        return finish(
          parseFeedToMarkdown(alt.content),
          "alternate-feed",
          "application/feed",
          url,
          finalUrl,
          alt.status,
        );
      }
    }

    ctx.signal?.throwIfAborted();

    // 5E: reader-backend chain.
    const htmlResult = await renderHtmlToText(rawContent, finalUrl, ctx);
    if (htmlResult.method === "browser") {
      notes.push("Page required JavaScript rendering (browser)");
    }
    if (!htmlResult.ok) {
      notes.push("html rendering failed (no reader backend produced usable output)");
      const llm = await tryLlmEndpoints(finalUrl, ctx);
      if (llm) {
        notes.push(`Used llms.txt fallback: ${llm.endpoint}`);
        return finish(llm.content, "llms.txt", "text/plain", url, finalUrl);
      }
      return finish(rawContent, "raw-html", mime, url, finalUrl, response.status);
    }

    if (isLowQualityOutput(htmlResult.content)) {
      const llm = await tryLlmEndpoints(finalUrl, ctx);
      if (llm) {
        notes.push(`Used llms.txt fallback: ${llm.endpoint}`);
        return finish(llm.content, "llms.txt", "text/plain", url, finalUrl);
      }
      notes.push("Page appears to require JavaScript or is mostly navigation");
    }

    return finish(htmlResult.content, htmlResult.method, mime, url, finalUrl, response.status);
  }

  return finish(rawContent, "raw", mime, url, finalUrl, response.status);
}

function normalizeUrl(url: string): string {
  const repaired = repairCollapsedScheme(url);
  if (!/^https?:\/\//i.test(repaired)) return `https://${repaired}`;
  return repaired;
}

function resolveUrl(target: string, base: string): string {
  if (target.startsWith("http")) return target;
  try {
    return new URL(target, base).href;
  } catch {
    return target;
  }
}

function formatJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
