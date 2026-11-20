/**
 * `robots.txt` parsing, matching, and a per-origin cache (RFC 9309).
 *
 * The parser keeps every group, selects the most specific group for a product
 * token, and answers allow/deny questions with the longest-match rule. The
 * cache keeps one result per origin for a bounded time, so probing several
 * URLs on one site costs one `robots.txt` read.
 */

import { systemClock, type Clock } from "./clock";
import { DEFAULT_PRODUCT_TOKEN } from "./user-agent";

/** One `Allow` or `Disallow` line. */
export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

/** One `User-agent` group and its rules. */
export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelayMs?: number;
  /** Interval implied by `Request-rate`, in milliseconds. */
  requestRateIntervalMs?: number;
}

/** A parsed `robots.txt` with the rules selected for one product token. */
export interface RobotsRules {
  /** False when the origin has no readable `robots.txt`. */
  present: boolean;
  groups: RobotsGroup[];
  /** Rules that apply to `productToken`. */
  rules: RobotsRule[];
  crawlDelayMs?: number;
  requestRateIntervalMs?: number;
  sitemaps: string[];
  productToken: string;
}

/** The answer for one path. */
export interface RobotsDecision {
  allowed: boolean;
  /** True when a rule matched; false means the path is allowed by default. */
  matched: boolean;
  /** The pattern that decided it. */
  rule?: string;
}

const EMPTY_RULES = (productToken: string): RobotsRules => ({
  present: false,
  groups: [],
  rules: [],
  sitemaps: [],
  productToken,
});

/** Parse `robots.txt` and select the groups that apply to `productToken`. */
export function parseRobots(text: string, productToken = DEFAULT_PRODUCT_TOKEN): RobotsRules {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (!value) continue;
      if (
        !current ||
        current.rules.length > 0 ||
        current.crawlDelayMs !== undefined ||
        current.requestRateIntervalMs !== undefined
      ) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;

    switch (field) {
      case "allow":
      case "disallow":
        if (!value) break;
        current.rules.push({ allow: field === "allow", pattern: value });
        break;
      case "crawl-delay": {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelayMs = seconds * 1000;
        break;
      }
      case "request-rate": {
        const rate = parseRequestRate(value);
        if (rate !== undefined) current.requestRateIntervalMs = rate;
        break;
      }
      case "sitemap":
        if (value) sitemaps.push(value);
        break;
      default:
        break;
    }
  }

  const selected = selectGroups(groups, productToken);
  const rules = selected.flatMap((group) => group.rules);
  const crawlDelayMs = maxDefined(selected.map((group) => group.crawlDelayMs));
  const requestRateIntervalMs = maxDefined(selected.map((group) => group.requestRateIntervalMs));
  const robots: RobotsRules = {
    present: true,
    groups,
    rules,
    sitemaps,
    productToken,
  };
  if (crawlDelayMs !== undefined) robots.crawlDelayMs = crawlDelayMs;
  if (requestRateIntervalMs !== undefined) robots.requestRateIntervalMs = requestRateIntervalMs;
  return robots;
}

/** Decide one path (pathname plus query) against the selected rules. */
export function robotsAllows(rules: RobotsRules, pathAndQuery: string): RobotsDecision {
  const path = normalizePath(pathAndQuery);
  let best: { rule: RobotsRule; length: number } | undefined;

  for (const rule of rules.rules) {
    const length = matchLength(rule.pattern, path);
    if (length === undefined) continue;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { rule, length };
    }
  }

  if (!best) return { allowed: true, matched: false };
  return { allowed: best.rule.allow, matched: true, rule: best.rule.pattern };
}

/**
 * The minimum gap a `robots.txt` asks for, from `Crawl-delay` and
 * `Request-rate`. Undefined when the file asks for neither.
 */
export function robotsIntervalMs(rules: RobotsRules): number | undefined {
  return maxDefined([rules.crawlDelayMs, rules.requestRateIntervalMs]);
}

export interface RobotsCacheOptions {
  clock?: Clock;
  /** How long a successful read stays fresh. */
  ttlMs?: number;
  /** How long an unreadable `robots.txt` suppresses further reads. */
  failureTtlMs?: number;
}

interface CacheEntry {
  rules: RobotsRules;
  fetchedAt: number;
  ok: boolean;
}

/** Per-origin `robots.txt` cache with in-flight de-duplication. */
export class RobotsCache {
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<RobotsRules>>();

  constructor(options: RobotsCacheOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.ttlMs = options.ttlMs ?? 60 * 60_000;
    this.failureTtlMs = options.failureTtlMs ?? 5 * 60_000;
  }

  /**
   * Rules for an origin. `load` is only called on a miss and shared by callers
   * that ask while a read is already running.
   */
  async rules(
    origin: string,
    load: () => Promise<string | undefined>,
    productToken = DEFAULT_PRODUCT_TOKEN,
  ): Promise<RobotsRules> {
    const key = `${origin}\n${productToken}`;
    const now = this.clock.now();
    const cached = this.entries.get(key);
    if (cached && now - cached.fetchedAt < (cached.ok ? this.ttlMs : this.failureTtlMs)) {
      return cached.rules;
    }

    const running = this.inflight.get(key);
    if (running) return running;

    const pending = (async () => {
      let rules: RobotsRules;
      let ok = false;
      try {
        const text = await load();
        if (text === undefined) {
          rules = EMPTY_RULES(productToken);
        } else {
          rules = parseRobots(text, productToken);
          ok = true;
        }
      } catch {
        rules = EMPTY_RULES(productToken);
      }
      this.entries.set(key, { rules, fetchedAt: this.clock.now(), ok });
      this.inflight.delete(key);
      return rules;
    })();

    this.inflight.set(key, pending);
    return pending;
  }

  /** Drop every cached origin; tests call this between cases. */
  reset(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}

/** True when the path is disallowed for the selected groups. */
export function robotsDisallows(rules: RobotsRules, pathAndQuery: string): boolean {
  const decision = robotsAllows(rules, pathAndQuery);
  return decision.matched && !decision.allowed;
}

/** `origin + /robots.txt`, or undefined when the origin is not absolute. */
export function robotsTxtUrl(origin: string): string | undefined {
  try {
    return new URL("/robots.txt", origin).href;
  } catch {
    return undefined;
  }
}

function selectGroups(groups: RobotsGroup[], productToken: string): RobotsGroup[] {
  const token = productToken.toLowerCase();
  const specific = groups.filter((group) =>
    group.agents.some((agent) => agent !== "*" && token.includes(agent)),
  );
  if (specific.length > 0) return specific;
  return groups.filter((group) => group.agents.includes("*"));
}

function normalizePath(pathAndQuery: string): string {
  if (pathAndQuery.startsWith("/")) return pathAndQuery;
  try {
    const url = new URL(pathAndQuery);
    return `${url.pathname}${url.search}`;
  } catch {
    return `/${pathAndQuery}`;
  }
}

/** Length of the pattern that matched, or undefined; longer patterns win. */
function matchLength(pattern: string, path: string): number | undefined {
  const anchored = pattern.endsWith("$");
  const core = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  const expression = new RegExp(`^${escaped}${anchored ? "$" : ""}`);
  if (!expression.test(path)) return undefined;
  return pattern.length;
}

function parseRequestRate(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return undefined;
  const requests = Number(match[1]);
  const seconds = Number(match[2]);
  if (!(requests > 0) || !(seconds > 0)) return undefined;
  return (seconds / requests) * 1000;
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.max(...defined) : undefined;
}
