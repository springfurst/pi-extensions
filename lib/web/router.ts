/**
 * Routing decisions for one web request: stay on the current rung, climb the
 * politeness ladder, hand the page to a human, or stop.
 *
 * The rules live in one pure function so the same answer applies to every
 * caller. Two invariants matter: a challenge is never something escalation can
 * solve, and a `robots.txt` refusal is never overridden by a higher tier.
 */

import { findHostPolicy } from "./politeness";
export { EscalationBudget } from "./politeness";
import type { EvasionMode, HostPolicy, HumanMode, PolitenessConfig, TierCeiling } from "./config";
import type { Outcome, Tier } from "./types";

/** The parts of the configuration that decide a route. */
export interface RoutingPolicy {
  /** Highest tier the ladder may reach. */
  tier: TierCeiling;
  /** Whether a hard block may use the evasive tier. */
  evasion: EvasionMode;
  /** What to do when a challenge appears. */
  human: HumanMode;
}

export interface RoutingInput {
  outcome: Outcome;
  /** Tier that produced the outcome. */
  tier: Tier;
  policy: RoutingPolicy;
  /** True when this host has escalated recently. */
  escalatedRecently: boolean;
  /** Human mode actually available; `undefined` means this tool cannot wait. */
  humanAvailable?: boolean;
}

/** What the runtime should do after one attempt. */
export type RoutingPlan =
  | { action: "accept" }
  | { action: "escalate"; to: 1 | 2; reason: string }
  | { action: "human"; mode: HumanMode; reason: string }
  | { action: "refuse"; reason: string };

/** Numeric ceiling for a policy. */
export function tierCeiling(policy: Pick<RoutingPolicy, "tier">): Tier {
  return policy.tier === "evasive" ? 2 : 1;
}

/** Decide the next step for one response. */
export function planRoute(input: RoutingInput): RoutingPlan {
  const ceiling = tierCeiling(input.policy);

  // A challenge needs a human; escalation cannot clear it.
  if (input.outcome === "challenge") {
    if (input.policy.human === "disabled") {
      return {
        action: "refuse",
        reason: "a challenge needs a human, and human handling is disabled",
      };
    }
    if (input.policy.human === "transparent" && input.humanAvailable === false) {
      return {
        action: "human",
        mode: "hint",
        reason: "a challenge needs a human; this call cannot wait, so it is reported instead",
      };
    }
    return { action: "human", mode: input.policy.human, reason: "a challenge needs a human" };
  }

  // `robots.txt` under `strict` already refused; no tier may override it.
  if (input.outcome === "robots-disallow") {
    return { action: "accept" };
  }

  if (input.outcome === "blocked-hard") {
    if (input.policy.evasion !== "on-block" || ceiling < 2) return { action: "accept" };
    if (input.tier >= 2) return { action: "accept" };
    if (input.escalatedRecently) return { action: "accept" };
    return {
      action: "escalate",
      to: 2,
      reason: "hard block; the evasive tier learns a more realistic fingerprint",
    };
  }

  if (input.outcome === "js-shell" || input.outcome === "quality-fail") {
    if (ceiling < 1 || input.tier >= 1) return { action: "accept" };
    if (input.escalatedRecently) return { action: "accept" };
    return {
      action: "escalate",
      to: 1,
      reason:
        input.outcome === "js-shell"
          ? "page needs JavaScript; a real browser can run it"
          : "content failed the quality gate; a real browser may render it",
    };
  }

  return { action: "accept" };
}

/** Resolve the routing policy for one host. */
export function routingPolicyFor(
  host: string,
  politeness: PolitenessConfig,
  hosts: Record<string, HostPolicy> | undefined,
): RoutingPolicy {
  const hostPolicy = findHostPolicy(host, hosts);
  return {
    tier: hostPolicy?.tier ?? politeness.tier,
    evasion: politeness.evasion,
    human: politeness.human,
  };
}

/** Clamp a requested tier to the policy ceiling. */
export function clampTier(tier: Tier | undefined, ceiling: Tier): Tier {
  const requested = tier ?? 0;
  return Math.max(0, Math.min(requested, ceiling)) as Tier;
}
