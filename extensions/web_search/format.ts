// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { formatAge, formatCount, truncate } from "../../lib/format";
import type { SearchResponse } from "./types";

/** Format a search response for the model. Notes (relaxed constraints) lead the output. */
export function formatForLLM(response: SearchResponse, notes: readonly string[] = []): string {
  const parts: string[] = [];
  for (const note of notes) parts.push(`Note: ${note}`);

  if (response.answer) {
    parts.push(response.answer);
    if (response.sources.length > 0)
      parts.push("\n## Sources", formatCount("source", response.sources.length));
  }

  for (const [index, source] of response.sources.entries()) {
    const age = formatAge(source.ageSeconds) || source.publishedDate;
    const agePart = age ? ` (${age})` : "";
    parts.push(`[${index + 1}] ${source.title}${agePart}\n    ${source.url}`);
    if (source.snippet) parts.push(`    ${truncate(source.snippet, 240)}`);
  }

  if (response.relatedQuestions && response.relatedQuestions.length > 0) {
    parts.push("\n## Related", formatCount("question", response.relatedQuestions.length));
    for (const question of response.relatedQuestions) parts.push(`- ${question}`);
  }

  if (response.sources.length === 0 && !response.answer) parts.push("No results found.");

  return parts.join("\n");
}
