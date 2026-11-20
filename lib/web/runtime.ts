/**
 * The runtime facade every web tool calls.
 *
 * A request always starts on the honest HTTP tier. The router decides whether
 * to stop there, climb to a real browser, or hand a challenge to a human.
 * Escalation is budgeted per host, a challenge never escalates, and an explicit
 * tier is a ceiling rather than a shortcut past `robots.txt`.
 */

import type { HttpCache } from "./cache";
import { systemClock, type Clock } from "./clock";
import type { Politeness } from "./politeness";
import { EscalationBudget, clampTier, planRoute, routingPolicyFor, tierCeiling } from "./router";
import { transfer, type FetchImpl } from "./transfer";
import type { ResolveHost } from "../security";
import type {
  SessionHandle,
  SessionOptions,
  Tier,
  WebRequest,
  WebResult,
  WebRuntime as WebRuntimeApi,
} from "./types";

/** A browser-backed transport for tiers 1 and 2. */
export interface BrowserTransport {
  (request: WebRequest, options: { tier: 1 | 2; signal?: AbortSignal }): Promise<WebResult>;
}

export interface WebRuntimeOptions {
  /** Limiter, host intervals, robots cache, and routing policy. */
  politeness: Politeness;
  /** Conditional-GET cache, when one is configured. */
  cache?: HttpCache;
  /** Browser transport; without it, escalation is reported but not attempted. */
  browser?: BrowserTransport;
  /**
   * Wait for a human to clear a challenge. Resolves true when the page became
   * usable. Without it, `transparent` degrades to a `hint`.
   */
  humanWaiter?: (context: { url: string; signal?: AbortSignal }) => Promise<boolean>;
  /** Session factory for callers that need a browser session handle. */
  sessions?: (id: string, options: SessionOptions) => Promise<SessionHandle>;
  /** Profile cookie header for `cookies: "profile"` requests. */
  cookieSource?: (url: string, signal?: AbortSignal) => Promise<string | undefined>;
  /** Injectable HTTP transport, for tests and embedding. */
  transfer?: typeof transfer;
  /** Transport capabilities inherited by every HTTP attempt. */
  fetchImpl?: FetchImpl;
  allowPrivateHosts?: boolean;
  resolve?: ResolveHost;
  timeoutSeconds?: number;
  maxBytes?: number;
  clock?: Clock;
  /** How often one host may escalate. */
  escalationWindowMs?: number;
}

/** Route one request through the politeness ladder. */
export class WebRuntime implements WebRuntimeApi {
  private readonly politeness: Politeness;
  private readonly budget: EscalationBudget;

  constructor(private readonly options: WebRuntimeOptions) {
    this.politeness = options.politeness;
    this.budget = new EscalationBudget({
      windowMs: options.escalationWindowMs,
      clock: options.clock ?? systemClock,
    });
  }

  /** Open a browser session through the injected factory. */
  async openSession(id: string, options: SessionOptions): Promise<SessionHandle> {
    if (!this.options.sessions) {
      throw new Error("This runtime has no browser session factory.");
    }
    return this.options.sessions(id, options);
  }

  /** Send one request and apply the routing rules to the result. */
  async request(request: WebRequest & { signal?: AbortSignal }): Promise<WebResult> {
    const host = hostOf(request.url);
    const policy = routingPolicyFor(host, this.politeness.config, this.politeness.hosts);
    const policyCeiling = tierCeiling(policy);
    const ceiling =
      request.tier === undefined ? policyCeiling : clampTier(request.tier, policyCeiling);
    const notes = new Set<string>();
    let tier: Tier = 0;
    let result = await this.honest(request, request.signal);

    for (let step = 0; step < 3; step++) {
      const plan = planRoute({
        outcome: result.outcome,
        tier,
        policy,
        escalatedRecently: !this.budget.available(host),
        /* debug */
        humanAvailable: Boolean(this.options.humanWaiter),
      });

      console.log("PLAN", host, result.outcome, tier, JSON.stringify(policy), JSON.stringify(plan));
      if (plan.action === "accept") break;

      if (plan.action === "refuse") {
        notes.add(plan.reason);
        break;
      }

      if (plan.action === "human") {
        if (plan.mode === "transparent" && this.options.humanWaiter) {
          const cleared = await this.options.humanWaiter({
            url: result.url,
            signal: request.signal,
          });
          if (!cleared) {
            notes.add("human wait ended without clearing the challenge");
            break;
          }
          notes.add("a human cleared the challenge");
          result = await this.honest(request, request.signal);
          continue;
        }
        notes.add(plan.reason);
        break;
      }

      // Escalation: only within the ceiling, once per host per window, and
      // only when a browser transport exists.
      if (plan.to > ceiling) {
        notes.add(`cannot escalate past the tier ${ceiling} ceiling for this call`);
        break;
      }
      if (!this.options.browser) {
        notes.add("no browser transport is available to escalate");
        break;
      }
      this.budget.take(host);
      notes.add(plan.reason);
      tier = plan.to;
      try {
        result = await this.options.browser(
          { ...request, tier: plan.to },
          { tier: plan.to, signal: request.signal },
        );
      } catch (error) {
        notes.add(
          `browser escalation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }

    return notes.size > 0 ? { ...result, notes: [...(result.notes ?? []), ...notes] } : result;
  }

  /** One honest HTTP attempt, mapped into the shared result shape. */
  private async honest(request: WebRequest, signal?: AbortSignal): Promise<WebResult> {
    let cookies: string | undefined;
    if (request.cookies === "profile" && this.options.cookieSource) {
      cookies = await this.options.cookieSource(request.url, signal);
    }
    const result = await (this.options.transfer ?? transfer)(request.url, {
      method: request.method,
      body: request.body,
      headers: request.headers,
      cookies,
      fetch: this.options.fetchImpl,
      allowPrivateHosts: this.options.allowPrivateHosts,
      resolve: this.options.resolve,
      timeoutSeconds: this.options.timeoutSeconds,
      maxBytes: this.options.maxBytes,
      politeness: this.politeness,
      cache: this.options.cache,
      signal,
    });
    return {
      url: result.finalUrl || request.url,
      status: result.status ?? 0,
      outcome: result.outcome ?? (result.ok ? "ok" : "http-error"),
      tier: 0,
      transport: "http",
      contentType: result.contentType || undefined,
      body: result.content,
      cached: result.cache === "hit" ? true : undefined,
      cache: result.cache,
      limiter: result.limiter,
      truncated: result.truncated,
      retryAfterMs: result.retryAfterMs,
      reason: result.error,
      notes: result.notes,
      challenge: result.challenge,
    };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
