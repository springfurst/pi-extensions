import { handleArxiv } from "./arxiv";
import { handleCratesIo } from "./crates-io";
import { handleDocsRs } from "./docs-rs";
import { handleGitHub } from "./github";
import { handleGitLab } from "./gitlab";
import { handleHackerNews } from "./hackernews";
import { handleMDN } from "./mdn";
import { handleNpm } from "./npm";
import { handlePubMed } from "./pubmed";
import { handlePyPI } from "./pypi";
import { handleReddit } from "./reddit";
import { handleRfc } from "./rfc";
import { handleSemanticScholar } from "./semantic-scholar";
import { handleStackOverflow } from "./stackoverflow";
import type { SpecialHandler } from "./types";
import { handleWikipedia } from "./wikipedia";

export type { FetchContext, RenderResult, SpecialHandler } from "./types";
export { buildResult, finalizeOutput, formatIsoDate, MAX_OUTPUT_CHARS } from "./types";

export { fetchGitHubApi, handleGitHub, parseGitHubUrl, stripActionsLogTimestamps } from "./github";
export { handleGitLab, parseGitLabUrl } from "./gitlab";
export { handleCratesIo } from "./crates-io";
export { handleNpm } from "./npm";
export { handlePyPI } from "./pypi";
export { handleArxiv } from "./arxiv";
export { handleDocsRs, parseDocsRsUrl } from "./docs-rs";
export { handleMDN } from "./mdn";
export { handlePubMed } from "./pubmed";
export { cleanRfcText, extractRfcNumber, handleRfc } from "./rfc";
export { extractPaperId, handleSemanticScholar } from "./semantic-scholar";
export { handleStackOverflow, getSiteParam } from "./stackoverflow";
export { decodeHNText, handleHackerNews } from "./hackernews";
export { handleReddit } from "./reddit";
export { handleWikipedia } from "./wikipedia";

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
  // Developer documentation
  handleMDN,
  handleDocsRs,
  // Academic and reference
  handleWikipedia,
  handleArxiv,
  handleSemanticScholar,
  handlePubMed,
  handleRfc,
  // Social and Q&A
  handleHackerNews,
  handleReddit,
  handleStackOverflow,
];
