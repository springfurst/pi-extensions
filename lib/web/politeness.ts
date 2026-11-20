/**
 * Learned politeness per host: how long to wait between requests and when a
 * host has asked us to back off.
 *
 * Limits start from a curated table, move with bounded additive-increase /
 * multiplicative-decrease learning from server signals, decay back toward the
 * curated value, and are stored in one JSON file so a restart keeps the warm
 * state. A sustained latency rise raises the interval one notch and makes the
 * next block learn faster; it never stops a host on its own.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { systemClock, type Clock } from "./clock";
import type { HostPolicy, PolitenessConfig } from "./config";
import { RequestLimiter } from "./limiter";
import { RobotsCache } from "./robots";

/** Version of the persisted host-state document. */
export const HOST_STATE_SCHEMA = 1;

/** Starting gaps, in milliseconds, for hosts with known expectations. */
export const CURATED_INTERVALS: Record<string, number> = {
  "arxiv.org": 3_000,
  "news.ycombinator.com": 1_000,
  "reddit.com": 2_000,
  "stackoverflow.com": 500,
  "github.com": 500,
  "en.wikipedia.org": 200,
  "duckduckgo.com": 1_000,
  "bing.com": 1_000,
  "google.com": 1_000,
  "mojeek.com": 1_000,
  "startpage.com": 1_000,
};

/** Gap for hosts that are neither configured nor curated. */
export const DEFAULT_HOST_INTERVAL_MS = 250;

/** Learned state for one host. */
export interface HostState {
  /** Gap between two requests to this host, before decay. */
  intervalMs: number;
  /** Lowest latency seen since the last reset, the baseline for the EWMA. */
  baselineMs?: number;
  /** Exponentially weighted mean latency. */
  ewmaMs?: number;
  /** Latency samples folded into the mean. */
  samples?: number;
  /** True while a sustained latency rise is in effect. */
  latencyWarning?: boolean;
  /** Epoch milliseconds before which the host must not be contacted. */
  blockedUntil?: number;
  /** Last interval change, used for decay and the TTL reset. */
  updatedAt: number;
}

/** The persisted document; one file per agent directory. */
export interface HostStateFile {
  schema: number;
  hosts: Record<string, HostState>;
}

export interface HostStateStoreOptions {
  /** State file; omit to keep state in memory only. */
  path?: string;
  clock?: Clock;
  /** Per-host overrides; `minIntervalMs` replaces the curated base. */
  hosts?: Record<string, HostPolicy>;
  curated?: Record<string, number>;
  defaultIntervalMs?: number;
  /** Learned values older than this fall back to the base. */
  ttlMs?: number;
  /** Fraction of the base removed from the interval per success. */
  decayFraction?: number;
  /** Fixed additive step; overrides `decayFraction` and `0` disables decay. */
  decayStepMs?: number;
  /** Multiplicative increase on a block, and the speed-up when warned. */
  blockMultiplier?: number;
  warnedBlockMultiplier?: number;
  /** Step used when a latency warning raises the interval one notch. */
  warningStep?: number;
  minMultiplier?: number;
  maxMultiplier?: number;
  /** Weight of the newest latency sample in the EWMA. */
  latencyAlpha?: number;
  /** Samples required before a latency rise can raise a warning. */
  latencyMinSamples?: number;
  latencyWarningFactor?: number;
}

/** Result of folding one observed request into the host's state. */
export interface HostUpdate {
  intervalMs: number;
  /** True when the update raised a latency warning and learned faster. */
  warningRaised: boolean;
}

/** Everything one directory shares across tool calls. */
export interface Politeness {
  readonly config: PolitenessConfig;
  readonly hosts: Record<string, HostPolicy>;
  readonly store: HostStateStore;
  readonly limiter: RequestLimiter;
  readonly robots: RobotsCache;
}

const shared = new Map<string, Politeness>();

/**
 * The politeness state shared by every tool call in this process for one
 * directory. The limiter must be shared so host gaps survive between calls;
 * the store is shared so latency learning and block state do too.
 */
export function sharedPoliteness(options: {
  dir: string;
  politeness: PolitenessConfig;
  hosts?: Record<string, HostPolicy>;
  clock?: Clock;
}): Politeness {
  const clock = options.clock ?? systemClock;
  const key = [
    options.dir,
    options.clock ? "fake" : "system",
    options.politeness.globalConcurrency,
    options.politeness.globalRequestsPerSecond,
    options.politeness.latencyWarningFactor,
    JSON.stringify(options.hosts ?? {}),
  ].join("|");
  const existing = shared.get(key);
  if (existing) return existing;

  const politeness: Politeness = {
    config: options.politeness,
    hosts: options.hosts ?? {},
    robots: new RobotsCache({ clock }),
    store: new HostStateStore({
      path: options.dir ? `${options.dir}/host-state.json` : undefined,
      clock,
      hosts: options.hosts,
      latencyWarningFactor: options.politeness.latencyWarningFactor,
    }),
    limiter: new RequestLimiter({
      globalConcurrency: options.politeness.globalConcurrency,
      globalRequestsPerSecond: options.politeness.globalRequestsPerSecond,
      clock,
    }),
  };
  shared.set(key, politeness);
  return politeness;
}

/** Drop the process-wide stores; tests call this between cases. */
export function resetSharedPoliteness(): void {
  shared.clear();
}

/** Resolve the policy for a host, matching parent domains as a fallback. */
export function findHostPolicy(
  host: string,
  hosts: Record<string, HostPolicy> | undefined,
): HostPolicy | undefined {
  if (!hosts) return undefined;
  for (const candidate of hostCandidates(host)) {
    const policy = hosts[candidate];
    if (policy) return policy;
  }
  return undefined;
}

/** Curated interval for a host, matching parent domains as a fallback. */
export function curatedIntervalFor(
  host: string,
  curated: Record<string, number> = CURATED_INTERVALS,
): number | undefined {
  for (const candidate of hostCandidates(host)) {
    const interval = curated[candidate];
    if (interval !== undefined) return interval;
  }
  return undefined;
}

/**
 * Host and its parent domains, longest first. A policy for `github.com` also
 * covers `api.github.com`, and `localhost:3000` is tried before `localhost`.
 */
function* hostCandidates(host: string): Generator<string> {
  const lower = host.trim().toLowerCase();
  const withoutPort = lower.replace(/:\d+$/, "");
  if (lower !== withoutPort) yield lower;
  const labels = withoutPort.split(".").filter(Boolean);
  for (let index = 0; index < labels.length; index++) {
    yield labels.slice(index).join(".");
  }
}

/** In-memory host state with optional atomic persistence. */
export class HostStateStore {
  private readonly clock: Clock;
  private readonly path?: string;
  private readonly hosts: Record<string, HostPolicy>;
  private readonly curated: Record<string, number>;
  private readonly defaultIntervalMs: number;
  private readonly ttlMs: number;
  private readonly decayFraction: number;
  private readonly decayStepMs?: number;
  private readonly blockMultiplier: number;
  private readonly warnedBlockMultiplier: number;
  private readonly warningStep: number;
  private readonly minMultiplier: number;
  private readonly maxMultiplier: number;
  private readonly latencyAlpha: number;
  private readonly latencyMinSamples: number;
  private readonly latencyWarningFactor: number;
  private readonly state: Record<string, HostState>;

  constructor(options: HostStateStoreOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.path = options.path;
    this.hosts = options.hosts ?? {};
    this.curated = options.curated ?? CURATED_INTERVALS;
    this.defaultIntervalMs = options.defaultIntervalMs ?? DEFAULT_HOST_INTERVAL_MS;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.decayFraction = options.decayFraction ?? 0.1;
    this.decayStepMs = options.decayStepMs;
    this.blockMultiplier = options.blockMultiplier ?? 2;
    this.warnedBlockMultiplier = options.warnedBlockMultiplier ?? 4;
    this.warningStep = options.warningStep ?? 1.25;
    this.minMultiplier = options.minMultiplier ?? 0.5;
    this.maxMultiplier = options.maxMultiplier ?? 4;
    this.latencyAlpha = options.latencyAlpha ?? 0.3;
    this.latencyMinSamples = options.latencyMinSamples ?? 3;
    this.latencyWarningFactor = options.latencyWarningFactor ?? 2;
    this.state = this.load();
  }

  /** Configured or curated gap for a host, before learning. */
  baseIntervalMs(host: string): number {
    const override = findHostPolicy(host, this.hosts)?.minIntervalMs;
    if (override !== undefined) return Math.max(0, override);
    return curatedIntervalFor(host, this.curated) ?? this.defaultIntervalMs;
  }

  /** The effective per-host gap, including learning and the TTL reset. */
  intervalMs(host: string): number {
    return this.effectiveInterval(host, this.clock.now());
  }

  /** Per-host policy resolved from configuration, if any. */
  policyFor(host: string): HostPolicy | undefined {
    return findHostPolicy(host, this.hosts);
  }

  /** Epoch milliseconds before which the host asked us not to return. */
  blockedUntil(host: string): number {
    return this.state[normalize(host)]?.blockedUntil ?? 0;
  }

  /** Milliseconds still to wait before touching a blocked host, or zero. */
  remainingBlockMs(host: string, now = this.clock.now()): number {
    return Math.max(0, this.blockedUntil(host) - now);
  }

  /**
   * Fold one successful request into the state: decay toward the base and
   * watch for a sustained latency rise.
   */
  noteSuccess(host: string, latencyMs: number): HostUpdate {
    const key = normalize(host);
    const now = this.clock.now();
    const base = this.baseIntervalMs(key);
    const current = this.effectiveInterval(key, now);
    const state = this.stateFor(key, now);
    let intervalMs = current;
    let changed = false;

    state.samples = (state.samples ?? 0) + 1;
    state.ewmaMs =
      state.ewmaMs === undefined
        ? latencyMs
        : this.latencyAlpha * latencyMs + (1 - this.latencyAlpha) * state.ewmaMs;
    state.baselineMs = Math.min(state.baselineMs ?? latencyMs, latencyMs);

    const warned =
      state.samples >= this.latencyMinSamples &&
      state.baselineMs > 0 &&
      state.ewmaMs > this.latencyWarningFactor * state.baselineMs;

    if (warned && !state.latencyWarning) {
      state.latencyWarning = true;
      intervalMs = this.clamp(base, current * this.warningStep);
      changed = intervalMs !== current;
    } else if (!state.latencyWarning) {
      const step = this.decayStepMs ?? Math.max(10, base * this.decayFraction);
      intervalMs = this.clamp(base, current - step);
      changed = intervalMs !== current;
    }

    if (changed) {
      state.intervalMs = intervalMs;
      state.updatedAt = now;
      this.persist();
    }
    return { intervalMs, warningRaised: warned };
  }

  /**
   * Fold a block or rate-limit response into the state: multiply the gap,
   * clamp it, and remember any `Retry-After`. A warning makes this learn
   * faster and is consumed by the block.
   */
  noteThrottle(host: string, retryAfterMs?: number): number {
    const key = normalize(host);
    const now = this.clock.now();
    const base = this.baseIntervalMs(key);
    const current = this.effectiveInterval(key, now);
    const state = this.stateFor(key, now);

    const multiplier = state.latencyWarning ? this.warnedBlockMultiplier : this.blockMultiplier;
    state.latencyWarning = false;
    state.samples = 0;
    state.intervalMs = this.clamp(base, current * multiplier);
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      state.blockedUntil = now + retryAfterMs;
    }
    state.updatedAt = now;
    this.persist();
    return state.intervalMs;
  }

  /** Record a `Retry-After` without changing the learned interval. */
  noteRetryAfter(host: string, retryAfterMs: number): void {
    if (!(retryAfterMs > 0)) return;
    const key = normalize(host);
    const state = this.stateFor(key, this.clock.now());
    state.blockedUntil = this.clock.now() + retryAfterMs;
    state.updatedAt = this.clock.now();
    this.persist();
  }

  /** Snapshot for diagnostics and tests. */
  snapshot(): HostStateFile {
    return { schema: HOST_STATE_SCHEMA, hosts: structuredClone(this.state) };
  }

  /** Write the state file atomically; failures never break a request. */
  save(): void {
    this.persist();
  }

  private effectiveInterval(host: string, now: number): number {
    const state = this.state[host];
    const base = this.baseIntervalMs(host);
    if (!state) return base;
    if (now - state.updatedAt > this.ttlMs) return base;
    return this.clamp(base, state.intervalMs);
  }

  private stateFor(host: string, now: number): HostState {
    const existing = this.state[host];
    if (existing && now - existing.updatedAt <= this.ttlMs) return existing;
    const fresh: HostState = {
      intervalMs: this.baseIntervalMs(host),
      updatedAt: now,
    };
    this.state[host] = fresh;
    return fresh;
  }

  private clamp(base: number, intervalMs: number): number {
    const lower = base * this.minMultiplier;
    const upper = Math.max(base, base * this.maxMultiplier);
    return Math.min(upper, Math.max(lower, intervalMs));
  }

  private load(): Record<string, HostState> {
    if (!this.path) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
      if (typeof parsed !== "object" || parsed === null) return {};
      const hosts = (parsed as { hosts?: unknown }).hosts;
      if (typeof hosts !== "object" || hosts === null || Array.isArray(hosts)) return {};
      const loaded: Record<string, HostState> = {};
      for (const [host, value] of Object.entries(hosts as Record<string, unknown>)) {
        const state = asHostState(value);
        if (state) loaded[normalize(host)] = state;
      }
      return loaded;
    } catch {
      // A missing or malformed file starts from a clean state.
      return {};
    }
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const body: HostStateFile = { schema: HOST_STATE_SCHEMA, hosts: this.state };
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`);
      renameSync(temporary, this.path);
    } catch {
      // A read-only agent directory must not break fetching.
    }
  }
}

function normalize(host: string): string {
  return host.trim().toLowerCase();
}

function asHostState(value: unknown): HostState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const intervalMs = record.intervalMs;
  const updatedAt = record.updatedAt;
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs < 0) {
    return undefined;
  }
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined;
  const state: HostState = { intervalMs, updatedAt };
  const baselineMs = optionalNumber(record.baselineMs);
  if (baselineMs !== undefined) state.baselineMs = baselineMs;
  const ewmaMs = optionalNumber(record.ewmaMs);
  if (ewmaMs !== undefined) state.ewmaMs = ewmaMs;
  const samples = optionalNumber(record.samples);
  if (samples !== undefined) state.samples = samples;
  if (record.latencyWarning === true) state.latencyWarning = true;
  const blockedUntil = optionalNumber(record.blockedUntil);
  if (blockedUntil !== undefined) state.blockedUntil = blockedUntil;
  return state;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
