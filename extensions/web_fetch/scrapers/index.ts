// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

export type { FetchContext, RenderResult, SpecialHandler } from "./types";
export { buildResult, finalizeOutput, formatIsoDate } from "./types";
export {
  SITE_REGISTRY,
  findSiteEntry,
  siteHostDefaults,
  siteMethods,
  type SiteEntry,
  type SiteStrategy,
  type SiteTarget,
} from "./registry";

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
export { handleWikipedia } from "./wikipedia";
