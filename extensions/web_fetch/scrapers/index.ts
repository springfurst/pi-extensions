import { handleCratesIo } from "./crates-io";
import { handleGitHub } from "./github";
import { handleGitLab } from "./gitlab";
import { handleNpm } from "./npm";
import { handlePyPI } from "./pypi";
import type { SpecialHandler } from "./types";

export type { FetchContext, RenderResult, SpecialHandler } from "./types";
export { buildResult, finalizeOutput, formatIsoDate, MAX_OUTPUT_CHARS } from "./types";

export { fetchGitHubApi, handleGitHub, parseGitHubUrl, stripActionsLogTimestamps } from "./github";
export { handleGitLab, parseGitLabUrl } from "./gitlab";
export { handleCratesIo } from "./crates-io";
export { handleNpm } from "./npm";
export { handlePyPI } from "./pypi";

/**
 * Site-specific handlers, tried in priority order before the generic pipeline.
 * Every handler is hostname-gated and returns `null` when it does not apply.
 */
export const specialHandlers: SpecialHandler[] = [
  // Git hosting
  handleGitHub,
  handleGitLab,
  // Package registries
  handleNpm,
  handlePyPI,
  handleCratesIo,
];
