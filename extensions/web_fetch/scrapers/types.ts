// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { finalizeOutput } from "../output";
import type { FetchContext, RenderResult } from "../types";

export type { FetchContext, RenderResult };
export { finalizeOutput };

/** Default render cap used by site-specific handlers before the pipeline reapplies the per-call cap. */
export const MAX_OUTPUT_CHARS = 500_000;

/**
 * A site-specific URL renderer. Returns `null` for URLs it does not own or
 * when it fails, so the generic pipeline resumes.
 */
export type SpecialHandler = (url: string, ctx: FetchContext) => Promise<RenderResult | null>;

export interface BuildResultOptions {
  url: string;
  finalUrl?: string;
  method: string;
  fetchedAt: string;
  notes?: string[];
  contentType?: string;
}

/** Build a `RenderResult` from markdown content, finalizing the output. */
export function buildResult(md: string, opts: BuildResultOptions): RenderResult {
  const output = finalizeOutput(md, MAX_OUTPUT_CHARS);
  return {
    url: opts.url,
    finalUrl: opts.finalUrl ?? opts.url,
    contentType: opts.contentType ?? "text/markdown",
    method: opts.method,
    content: output.content,
    fetchedAt: opts.fetchedAt,
    truncated: output.truncated,
    notes: opts.notes ?? [],
  };
}

/** Format a date value as `YYYY-MM-DD`, returning an empty string on invalid input. */
export function formatIsoDate(value?: string | number | Date): string {
  if (value == null) return "";
  if (typeof value === "string") {
    const datePrefix = value.match(/^\d{4}-\d{2}-\d{2}/);
    if (datePrefix) return datePrefix[0];
  }
  try {
    return new Date(value).toISOString().split("T")[0]!;
  } catch {
    return "";
  }
}

/** Parse JSON defensively. */
export function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Run `fn` over `items` with at most `limit` concurrent calls, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      signal?.throwIfAborted();
      const index = next++;
      if (index >= items.length) break;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
