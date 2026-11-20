import { describe, expect, it } from "vitest";
import { FakeClock } from "./__fixtures__/clock";
import {
  EscalationBudget,
  clampTier,
  planRoute,
  routingPolicyFor,
  tierCeiling,
  type RoutingInput,
  type RoutingPolicy,
} from "./router";

const polite: RoutingPolicy = { tier: "polite", evasion: "off", human: "hint" };
const evasive: RoutingPolicy = { tier: "evasive", evasion: "on-block", human: "hint" };

function route(input: Partial<RoutingInput> & Pick<RoutingInput, "outcome">): unknown {
  return planRoute({
    tier: 0,
    policy: polite,
    escalatedRecently: false,
    ...input,
  });
}

describe("tierCeiling", () => {
  it("maps the policy names to rungs", () => {
    expect(tierCeiling({ tier: "polite" })).toBe(1);
    expect(tierCeiling({ tier: "evasive" })).toBe(2);
  });
});

describe("clampTier", () => {
  it("never lets a request exceed the ceiling", () => {
    expect(clampTier(undefined, 1)).toBe(0);
    expect(clampTier(2, 1)).toBe(1);
    expect(clampTier(2, 2)).toBe(2);
    expect(clampTier(-3 as never, 1)).toBe(0);
  });
});

describe("planRoute", () => {
  it("accepts usable content", () => {
    expect(route({ outcome: "ok" })).toEqual({ action: "accept" });
  });

  it("escalates a JavaScript shell to a real browser", () => {
    expect(route({ outcome: "js-shell" })).toEqual({
      action: "escalate",
      to: 1,
      reason: "page needs JavaScript; a real browser can run it",
    });
  });

  it("escalates a quality failure to a real browser", () => {
    expect(route({ outcome: "quality-fail" })).toMatchObject({ action: "escalate", to: 1 });
  });

  it("does not escalate past the polite ceiling", () => {
    expect(route({ outcome: "js-shell", tier: 1 })).toEqual({ action: "accept" });
    expect(route({ outcome: "js-shell", policy: { ...polite, tier: "polite" }, tier: 1 })).toEqual({
      action: "accept",
    });
  });

  it("routes a challenge to the configured human mode", () => {
    expect(route({ outcome: "challenge" })).toEqual({
      action: "human",
      mode: "hint",
      reason: "a challenge needs a human",
    });
  });

  it("never escalates a challenge, even with the evasive tier available", () => {
    expect(route({ outcome: "challenge", policy: evasive })).toMatchObject({
      action: "human",
      mode: "hint",
    });
  });

  it("executes the transparent mode when the caller can wait", () => {
    expect(route({ outcome: "challenge", policy: { ...polite, human: "transparent" } })).toEqual({
      action: "human",
      mode: "transparent",
      reason: "a challenge needs a human",
    });
  });

  it("falls back to a hint when transparent cannot wait", () => {
    expect(
      route({
        outcome: "challenge",
        policy: { ...polite, human: "transparent" },
        humanAvailable: false,
      }),
    ).toEqual({
      action: "human",
      mode: "hint",
      reason: "a challenge needs a human; this call cannot wait, so it is reported instead",
    });
  });

  it("refuses a challenge when human handling is disabled", () => {
    expect(route({ outcome: "challenge", policy: { ...polite, human: "disabled" } })).toEqual({
      action: "refuse",
      reason: "a challenge needs a human, and human handling is disabled",
    });
  });

  it("escalates a hard block only when evasion is on", () => {
    expect(route({ outcome: "blocked-hard", policy: evasive })).toMatchObject({
      action: "escalate",
      to: 2,
    });
    expect(route({ outcome: "blocked-hard" })).toEqual({ action: "accept" });
    expect(route({ outcome: "blocked-hard", policy: { ...evasive, evasion: "off" } })).toEqual({
      action: "accept",
    });
  });

  it("stops escalating when the host escalated recently", () => {
    expect(route({ outcome: "blocked-hard", policy: evasive, escalatedRecently: true })).toEqual({
      action: "accept",
    });
    expect(route({ outcome: "js-shell", escalatedRecently: true })).toEqual({ action: "accept" });
  });

  it("never overrides a robots refusal", () => {
    expect(route({ outcome: "robots-disallow", policy: evasive, tier: 0 })).toEqual({
      action: "accept",
    });
  });

  it("leaves throttling and other failures to the caller", () => {
    expect(route({ outcome: "throttled" })).toEqual({ action: "accept" });
    expect(route({ outcome: "consent" })).toEqual({ action: "accept" });
    expect(route({ outcome: "http-error" })).toEqual({ action: "accept" });
  });
});

describe("EscalationBudget", () => {
  it("allows one escalation per host per window", () => {
    const clock = new FakeClock();
    const budget = new EscalationBudget({ clock, windowMs: 10 * 60_000 });
    expect(budget.available("example.com")).toBe(true);
    budget.take("example.com");
    expect(budget.available("example.com")).toBe(false);
    expect(budget.available("other.example")).toBe(true);
    clock.advanceBy(10 * 60_000);
    expect(budget.available("example.com")).toBe(true);
  });

  it("resets on demand", () => {
    const budget = new EscalationBudget();
    budget.take("example.com");
    budget.reset();
    expect(budget.available("example.com")).toBe(true);
  });
});

describe("routingPolicyFor", () => {
  const politeness = {
    robots: "warn" as const,
    tier: "polite" as const,
    evasion: "off" as const,
    human: "hint" as const,
    globalConcurrency: 4,
    globalRequestsPerSecond: 8,
    latencyWarningFactor: 2,
    maxRetryWaitSeconds: 30,
  };

  it("uses the global policy without a host entry", () => {
    expect(routingPolicyFor("example.com", politeness, {})).toEqual({
      tier: "polite",
      evasion: "off",
      human: "hint",
    });
  });

  it("lets a host entry raise the ceiling", () => {
    expect(
      routingPolicyFor("arxiv.org", politeness, { "arxiv.org": { tier: "evasive" } }),
    ).toMatchObject({ tier: "evasive" });
    expect(
      routingPolicyFor("export.arxiv.org", politeness, { "arxiv.org": { tier: "evasive" } }),
    ).toMatchObject({ tier: "evasive" });
  });
});
