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
