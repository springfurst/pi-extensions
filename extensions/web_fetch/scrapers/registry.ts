// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import type { HostPolicy } from "../../../lib/web/config";
import { findHostPolicy } from "../../../lib/web/politeness";
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
import { handleRfc } from "./rfc";
import { handleSemanticScholar } from "./semantic-scholar";
import { handleStackOverflow } from "./stackoverflow";
import type { SpecialHandler } from "./types";
import { handleWikipedia } from "./wikipedia";

/** Transports a site can be read through, most specific first. */
export type SiteStrategy = "api" | "reader" | "browser";

/** One host, or a host group, a site entry claims. */
export interface SiteTarget {
  /** Hostname without a scheme or path, e.g. `docs.rs`. */
  host: string;
  /** Also claim every subdomain of `host`. */
  subdomains?: boolean;
  /** Claim only paths that start with this prefix. */
  path?: string;
}

/** A declarative site entry: which URLs a handler owns and how it reads them. */
export interface SiteEntry {
  /** Stable identifier for tests and diagnostics. */
  id: string;
  /** Name used in documentation and result notes. */
  label: string;
  /** Hosts this entry owns, in claim order. The first match wins. */
  targets: readonly SiteTarget[];
  /** Pipeline methods the handler can produce, used to classify usage records. */
  methods: readonly string[];
  /** Transports the handler uses, most specific first. */
  strategies: readonly SiteStrategy[];
  /** Environment variables that unlock authenticated or higher-limit access. */
  env?: readonly string[];
  /**
   * Starting request gaps for the hosts the handler contacts beyond the
   * requested one. Configuration wins over these values.
   */
  hostDefaults?: Readonly<Record<string, HostPolicy>>;
  /** The rendering function; it keeps its own URL parsing and output shaping. */
  handler: SpecialHandler;
}

/** Site entries, tried in order. A host is owned by exactly one entry. */
export const SITE_REGISTRY: readonly SiteEntry[] = [
  {
    id: "github",
    label: "GitHub",
    targets: [{ host: "github.com" }],
    methods: [
      "github-raw",
      "github-tree",
      "github-commit",
      "github-pr",
      "github-issue",
      "github-issues",
      "github-repo",
      "github-actions-run",
      "github-actions-job",
    ],
    strategies: ["api"],
    env: ["GITHUB_TOKEN", "GH_TOKEN"],
    handler: handleGitHub,
  },
  {
    id: "gitlab",
    label: "GitLab",
    targets: [{ host: "gitlab.com" }],
    methods: ["gitlab-raw", "gitlab-tree", "gitlab-issue", "gitlab-mr", "gitlab-repo"],
    strategies: ["api"],
    handler: handleGitLab,
  },
  {
    id: "npm",
    label: "npm",
    targets: [{ host: "npmjs.com" }, { host: "www.npmjs.com" }],
    methods: ["npm"],
    strategies: ["api"],
    handler: handleNpm,
  },
  {
    id: "pypi",
    label: "PyPI",
    targets: [{ host: "pypi.org" }, { host: "www.pypi.org" }],
    methods: ["pypi"],
    strategies: ["api"],
    handler: handlePyPI,
  },
  {
    id: "crates-io",
    label: "crates.io",
    targets: [{ host: "crates.io" }, { host: "www.crates.io" }],
    methods: ["crates.io"],
    strategies: ["api"],
    handler: handleCratesIo,
  },
  {
    id: "mdn",
    label: "MDN",
    targets: [{ host: "developer.mozilla.org" }],
    methods: ["mdn"],
    strategies: ["api"],
    handler: handleMDN,
  },
  {
    id: "docs-rs",
    label: "docs.rs",
    targets: [{ host: "docs.rs" }],
    methods: ["docs.rs"],
    strategies: ["api"],
    handler: handleDocsRs,
  },
  {
    id: "wikipedia",
    label: "Wikipedia",
    targets: [{ host: "wikipedia.org", subdomains: true }],
    methods: ["wikipedia"],
    strategies: ["api"],
    handler: handleWikipedia,
  },
  {
    id: "arxiv",
    label: "arXiv",
    targets: [{ host: "arxiv.org" }],
    methods: ["arxiv"],
    strategies: ["api"],
    handler: handleArxiv,
  },
  {
    id: "semantic-scholar",
    label: "Semantic Scholar",
    targets: [{ host: "semanticscholar.org", subdomains: true }],
    methods: ["semantic-scholar"],
    strategies: ["api"],
    hostDefaults: { "api.semanticscholar.org": { minIntervalMs: 1_000 } },
    handler: handleSemanticScholar,
  },
  {
    id: "pubmed",
    label: "PubMed",
    targets: [{ host: "pubmed.ncbi.nlm.nih.gov" }, { host: "ncbi.nlm.nih.gov", path: "/pubmed" }],
    methods: ["pubmed"],
    strategies: ["api"],
    env: ["NCBI_API_KEY"],
    hostDefaults: { "eutils.ncbi.nlm.nih.gov": { minIntervalMs: 350 } },
    handler: handlePubMed,
  },
  {
    id: "rfc",
    label: "RFC",
    targets: [
      { host: "rfc-editor.org" },
      { host: "www.rfc-editor.org" },
      { host: "datatracker.ietf.org" },
      { host: "tools.ietf.org" },
    ],
    methods: ["rfc"],
    strategies: ["api"],
    handler: handleRfc,
  },
  {
    id: "hackernews",
    label: "Hacker News",
    targets: [{ host: "news.ycombinator.com" }],
    methods: ["hackernews"],
    strategies: ["api"],
    handler: handleHackerNews,
  },
  {
    id: "stackexchange",
    label: "Stack Exchange",
    targets: [
      { host: "stackoverflow.com", subdomains: true },
      { host: "superuser.com", subdomains: true },
      { host: "serverfault.com", subdomains: true },
      { host: "askubuntu.com", subdomains: true },
      { host: "mathoverflow.net", subdomains: true },
      { host: "stackapps.com", subdomains: true },
      { host: "stackexchange.com", subdomains: true },
    ],
    methods: ["stackexchange"],
    strategies: ["api"],
    hostDefaults: { "api.stackexchange.com": { minIntervalMs: 500 } },
    handler: handleStackOverflow,
  },
];

/** Every pipeline method a site handler can emit. */
export function siteMethods(entries: readonly SiteEntry[] = SITE_REGISTRY): Set<string> {
  return new Set(entries.flatMap((entry) => entry.methods));
}

/** The site entry that owns a URL, or undefined for the generic pipeline. */
export function findSiteEntry(
  url: string,
  entries: readonly SiteEntry[] = SITE_REGISTRY,
): SiteEntry | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const host = parsed.hostname.toLowerCase();
  for (const entry of entries) {
    if (entry.targets.some((target) => targetMatches(target, host, parsed.pathname))) return entry;
  }
  return undefined;
}

function targetMatches(target: SiteTarget, host: string, pathname: string): boolean {
  const wanted = target.host.toLowerCase();
  const hostMatches = target.subdomains
    ? host === wanted || host.endsWith(`.${wanted}`)
    : host === wanted;
  if (!hostMatches) return false;
  return target.path === undefined || pathname.startsWith(target.path);
}

/**
 * Starting gaps declared by the registry, minus every host the caller already
 * configured (directly or through a parent domain). Configuration wins.
 */
export function siteHostDefaults(
  configured: Record<string, HostPolicy> = {},
  entries: readonly SiteEntry[] = SITE_REGISTRY,
): Record<string, HostPolicy> {
  const defaults: Record<string, HostPolicy> = {};
  for (const entry of entries) {
    for (const [host, policy] of Object.entries(entry.hostDefaults ?? {})) {
      if (findHostPolicy(host, configured)?.minIntervalMs !== undefined) continue;
      defaults[host] = { ...policy, ...defaults[host] };
    }
  }
  return defaults;
}
