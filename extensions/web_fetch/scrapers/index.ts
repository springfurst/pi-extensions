import type { SpecialHandler } from "./types";

export type { FetchContext, RenderResult, SpecialHandler } from "./types";
export { buildResult, finalizeOutput, formatIsoDate, MAX_OUTPUT_CHARS } from "./types";

/**
 * Site-specific handlers, tried in priority order before the generic pipeline.
 * Every handler is hostname-gated and returns `null` when it does not apply.
 */
export const specialHandlers: SpecialHandler[] = [];
