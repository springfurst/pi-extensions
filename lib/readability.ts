// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { Readability } from "@mozilla/readability";
import { parseDocument } from "./dom";
import { htmlToBasicMarkdown } from "./markdown";

/** In-process article extraction with Readability, then Turndown. */
export function readabilityToMarkdown(html: string): string | null {
  const document = parseDocument(html);
  const article = new Readability(document as unknown as Document).parse();
  if (!article?.content) return null;
  return htmlToBasicMarkdown(article.content);
}

/**
 * Markdown image whose destination is an inline `data:` URI. The label allows
 * backslash escapes; the scheme is matched case-insensitively, the destination
 * may be bare or `<…>`-wrapped, and an optional title is consumed.
 */
const DATA_URI_IMAGE_RE =
  /!\[((?:\\.|[^\\\]])*)\]\(\s*(?:<data:[^>]*>|data:[^)\s]*)(?:\s+(?:"(?:\\.|[^\\"])*"|'(?:\\.|[^\\'])*'|\((?:\\.|[^\\)])*\)))?\s*\)/gi;

/** Drop inline `data:` image payloads, keeping any alt text. */
export function stripDataUriImages(markdown: string): string {
  return markdown.replace(DATA_URI_IMAGE_RE, (_match, alt: string) =>
    alt.trim() ? `![${alt}]` : "",
  );
}
