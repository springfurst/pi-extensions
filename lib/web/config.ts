/**
 * Web configuration sections shared by every web tool.
 *
 * `web-tools.json` and `browser-pilot.json` both accept `runtime`,
 * `politeness`, `hosts`, and `blocking`. The loaders own file discovery and
 * environment fallbacks; this module owns the shape, the built-in defaults, and
 * the merge rules so both tools agree on what a value means.
 */

import type { IsolationMode } from "./types";

/** How a second process joins a running browser. */
export type AttachMode = "auto" | "off";

/** Highest tier the router may reach: `polite` stops at 1, `evasive` allows 2. */
export type TierCeiling = "polite" | "evasive";

/** `robots.txt` handling: report and continue, or refuse with a reason. */
export type RobotsMode = "warn" | "strict";

/** When the evasive tier may be used. */
export type EvasionMode = "off" | "on-block";

/** What happens when a CAPTCHA or interstitial is detected. */
export type HumanMode = "transparent" | "hint" | "disabled";

/** Whether a subresource category is blocked. */
export type BlockingMode = "off" | "third-party";

/** Subresource categories that can be blocked independently. */
export const BLOCKING_CATEGORIES = ["ads", "analytics", "images", "media", "fonts"] as const;

export type BlockingCategory = (typeof BLOCKING_CATEGORIES)[number];

/** Process, profile, and session shape shared by every web tool. */
export interface RuntimeConfig {
  /** Profile name; one browser process is kept per profile. */
  profile: string;
  /** Attach to a live DevTools endpoint instead of failing on a busy profile. */
  attach: AttachMode;
  /** `tabs` shares the warm cookie jar, `contexts` isolates cookies per session. */
  isolation: IsolationMode;
  /** Page pool ceiling for the shared browser. */
  maxPages: number;
}

/** Politeness ladder and the budgets behind it. */
export interface PolitenessConfig {
  /** `robots.txt` handling for hosts without a per-host override. */
  robots: RobotsMode;
  /** Default tier ceiling. */
  tier: TierCeiling;
  /** Whether a hard block may escalate to the evasive tier. */
  evasion: EvasionMode;
  /** Response to a detected CAPTCHA or interstitial. */
  human: HumanMode;
  /** Requests in flight across every host. */
  globalConcurrency: number;
  /** Requests per second across every host. */
  globalRequestsPerSecond: number;
  /** Latency factor over the host baseline that raises a warning. */
  latencyWarningFactor: number;
}

/** Per-host overrides; absent fields fall back to the global sections. */
export interface HostPolicy {
  /** Minimum gap between two requests to this host, in milliseconds. */
  minIntervalMs?: number;
  /** `robots.txt` handling for this host. */
  robots?: RobotsMode;
  /** Tier ceiling for this host. */
  tier?: TierCeiling;
  /** Subresource categories this host may load despite `blocking`. */
  allow?: BlockingCategory[];
}

/** Subresource blocking categories for hosts without a per-host override. */
export type BlockingConfig = Record<BlockingCategory, BlockingMode>;

/** The four sections both config files share, after merging. */
export interface SharedWebConfig {
  runtime: RuntimeConfig;
  politeness: PolitenessConfig;
  hosts: Record<string, HostPolicy>;
  blocking: BlockingConfig;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  profile: "shared",
  attach: "auto",
  isolation: "tabs",
  maxPages: 6,
};

export const DEFAULT_POLITENESS_CONFIG: PolitenessConfig = {
  robots: "warn",
  tier: "polite",
  evasion: "off",
  human: "hint",
  globalConcurrency: 4,
  globalRequestsPerSecond: 8,
  latencyWarningFactor: 2,
};

export const DEFAULT_BLOCKING_CONFIG: BlockingConfig = {
  ads: "third-party",
  analytics: "third-party",
  images: "third-party",
  media: "third-party",
  fonts: "third-party",
};

/**
 * Merge the shared sections out of two parsed config files.
 *
 * Defaults come first, then the global file, then the trusted project file.
 * Malformed values are dropped individually so one wrong key never discards the
 * rest of the file. Per-host entries merge field by field across files.
 */
export function mergeWebSections(globalRaw: unknown, projectRaw: unknown): SharedWebConfig {
  const global = asRecord(globalRaw);
  const project = asRecord(projectRaw);

  return {
    runtime: {
      ...DEFAULT_RUNTIME_CONFIG,
      ...pickRuntime(asRecord(global?.runtime)),
      ...pickRuntime(asRecord(project?.runtime)),
    },
    politeness: {
      ...DEFAULT_POLITENESS_CONFIG,
      ...pickPoliteness(asRecord(global?.politeness)),
      ...pickPoliteness(asRecord(project?.politeness)),
    },
    hosts: mergeHosts(asRecord(global?.hosts), asRecord(project?.hosts)),
    blocking: {
      ...DEFAULT_BLOCKING_CONFIG,
      ...pickBlocking(asRecord(global?.blocking)),
      ...pickBlocking(asRecord(project?.blocking)),
    },
  };
}

function pickRuntime(raw: Record<string, unknown> | undefined): Partial<RuntimeConfig> {
  if (!raw) return {};
  const out: Partial<RuntimeConfig> = {};
  const profile = asNonEmptyString(raw.profile);
  if (profile !== undefined) out.profile = profile;
  const attach = asAttachMode(raw.attach);
  if (attach !== undefined) out.attach = attach;
  const isolation = asIsolationMode(raw.isolation);
  if (isolation !== undefined) out.isolation = isolation;
  const maxPages = asPositiveInteger(raw.maxPages);
  if (maxPages !== undefined) out.maxPages = maxPages;
  return out;
}

function pickPoliteness(raw: Record<string, unknown> | undefined): Partial<PolitenessConfig> {
  if (!raw) return {};
  const out: Partial<PolitenessConfig> = {};
  const robots = asRobotsMode(raw.robots);
  if (robots !== undefined) out.robots = robots;
  const tier = asTierCeiling(raw.tier);
  if (tier !== undefined) out.tier = tier;
  const evasion = asEvasionMode(raw.evasion);
  if (evasion !== undefined) out.evasion = evasion;
  const human = asHumanMode(raw.human);
  if (human !== undefined) out.human = human;
  const globalConcurrency = asPositiveInteger(raw.globalConcurrency);
  if (globalConcurrency !== undefined) out.globalConcurrency = globalConcurrency;
  const globalRequestsPerSecond = asPositiveNumber(raw.globalRequestsPerSecond);
  if (globalRequestsPerSecond !== undefined) {
    out.globalRequestsPerSecond = globalRequestsPerSecond;
  }
  const latencyWarningFactor = asNumberAboveOne(raw.latencyWarningFactor);
  if (latencyWarningFactor !== undefined) out.latencyWarningFactor = latencyWarningFactor;
  return out;
}

function pickBlocking(raw: Record<string, unknown> | undefined): Partial<BlockingConfig> {
  if (!raw) return {};
  const out: Partial<BlockingConfig> = {};
  for (const category of BLOCKING_CATEGORIES) {
    const mode = asBlockingMode(raw[category]);
    if (mode !== undefined) out[category] = mode;
  }
  return out;
}

function mergeHosts(
  global: Record<string, unknown> | undefined,
  project: Record<string, unknown> | undefined,
): Record<string, HostPolicy> {
  const merged: Record<string, HostPolicy> = {};
  for (const key of new Set([...Object.keys(global ?? {}), ...Object.keys(project ?? {})])) {
    const host = normalizeHost(key);
    if (!host) continue;
    const policy: HostPolicy = {
      ...pickHostPolicy(asRecord(global?.[key])),
      ...pickHostPolicy(asRecord(project?.[key])),
    };
    merged[host] = { ...merged[host], ...policy };
  }
  return merged;
}

function pickHostPolicy(raw: Record<string, unknown> | undefined): HostPolicy {
  if (!raw) return {};
  const out: HostPolicy = {};
  const minIntervalMs = asNonNegativeNumber(raw.minIntervalMs);
  if (minIntervalMs !== undefined) out.minIntervalMs = minIntervalMs;
  const robots = asRobotsMode(raw.robots);
  if (robots !== undefined) out.robots = robots;
  const tier = asTierCeiling(raw.tier);
  if (tier !== undefined) out.tier = tier;
  const allow = asBlockingCategories(raw.allow);
  if (allow !== undefined) out.allow = allow;
  return out;
}

/**
 * Normalize a `hosts` key: lowercase, no trailing root dot, optional port.
 * Anything that is not host-shaped (a full URL, a path, a blank key) is dropped.
 */
function normalizeHost(value: string): string | undefined {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9*.-]+(:\d+)?$/.test(host) ? host : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function asNumberAboveOne(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 1) return undefined;
  return value;
}

function asPositiveInteger(value: unknown): number | undefined {
  const number = asPositiveNumber(value);
  return number === undefined ? undefined : Math.max(1, Math.floor(number));
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asAttachMode(value: unknown): AttachMode | undefined {
  return value === "auto" || value === "off" ? value : undefined;
}

function asIsolationMode(value: unknown): IsolationMode | undefined {
  return value === "tabs" || value === "contexts" ? value : undefined;
}

function asTierCeiling(value: unknown): TierCeiling | undefined {
  return value === "polite" || value === "evasive" ? value : undefined;
}

function asRobotsMode(value: unknown): RobotsMode | undefined {
  return value === "warn" || value === "strict" ? value : undefined;
}

function asEvasionMode(value: unknown): EvasionMode | undefined {
  return value === "off" || value === "on-block" ? value : undefined;
}

function asHumanMode(value: unknown): HumanMode | undefined {
  return value === "transparent" || value === "hint" || value === "disabled" ? value : undefined;
}

function asBlockingMode(value: unknown): BlockingMode | undefined {
  return value === "off" || value === "third-party" ? value : undefined;
}

/** Accept a single category as well as a list, ignoring names that do not exist. */
function asBlockingCategories(value: unknown): BlockingCategory[] | undefined {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  if (!items) return undefined;
  const categories: BlockingCategory[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const category = item.trim();
    if (!(BLOCKING_CATEGORIES as readonly string[]).includes(category)) continue;
    if (!categories.includes(category as BlockingCategory)) {
      categories.push(category as BlockingCategory);
    }
  }
  return categories;
}
