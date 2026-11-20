/**
 * One place that decides what a response is: usable content, a JavaScript
 * shell, a consent wall, a rate limit, a hard block, or a challenge.
 *
 * Every caller needs the same answer, so the markers live here and the routing
 * decision is made once. A blocking CAPTCHA or interstitial is reported as
 * `challenge` and is never something a client can escalate past; only a human
 * can clear it. A CAPTCHA widget embedded in otherwise usable content is
 * reported as `present` and does not on its own fail the read.
 */

import type { ChallengeSummary, Outcome } from "./types";

/** Text that marks an interstitial rather than the page that was requested. */
export const CHALLENGE_TEXT_MARKERS = [
  "just a moment",
  "checking your browser",
  "verify you are human",
  "verifying you are human",
  "attention required",
  "pardon our interruption",
  "are you a robot",
  "please verify you are a human",
  "enable javascript and cookies to continue",
  "making sure you're not a bot",
  "press & hold",
];

/** DOM and script markers that make the page itself unusable without a human. */
export const CHALLENGE_BLOCKING_MARKERS = [
  "challenge-form",
  "cf-challenge-running",
  "challenge-platform",
  "challenges.cloudflare.com",
  "px-captcha",
  "perimeterx",
  "datadome",
];

/** CAPTCHA widget markers that may appear alongside otherwise usable content. */
export const CHALLENGE_PRESENT_MARKERS = [
  "g-recaptcha",
  "h-captcha",
  "data-sitekey",
  "recaptcha",
  "hcaptcha",
];

/** All DOM and script markers used by challenge providers. */
export const CHALLENGE_MARKERS = [...CHALLENGE_BLOCKING_MARKERS, ...CHALLENGE_PRESENT_MARKERS];

/** Response headers some challenge providers add. */
export const CHALLENGE_HEADERS = ["cf-mitigated", "x-datadome", "x-px-block"];

/** Markers of a page that needs JavaScript to show its content. */
export const JS_SHELL_MARKERS = [
  "enable javascript",
  "javascript is required",
  "requires javascript",
  "you need to enable javascript",
  "please enable javascript",
  "javascript must be enabled",
];

/** Markers of a consent wall that must not be accepted on the caller's behalf. */
export const CONSENT_MARKERS = [
  "we value your privacy",
  "before you continue",
  "consent to the use of cookies",
  "cookie consent",
  "manage your cookie",
  "accept all cookies",
  "your privacy choices",
];

/** How long to wait when a throttled response gives no `Retry-After`. */
export const DEFAULT_RETRY_DELAY_MS = 1_000;

export interface ResponseSignals {
  status: number;
  url?: string;
  headers?: Headers | Record<string, string | undefined>;
  body?: string;
  contentType?: string;
}

/** The classification of one response. */
export interface ResponseClassification {
  outcome: Outcome;
  /** Short explanation for logs and tool notes. */
  reason?: string;
  /** Delay the host asked for, in milliseconds. */
  retryAfterMs?: number;
  /** Classifier output when `outcome` is `challenge`. */
  challenge?: ChallengeSummary;
}

/** A classified challenge: the family, how bad it is, and why. */
export function detectChallenge(signals: ResponseSignals): ChallengeSummary | undefined {
  const body = (signals.body ?? "").toLowerCase();
  const markers = headerValues(signals.headers).join("\n").toLowerCase();
  const text = CHALLENGE_TEXT_MARKERS.find((marker) => body.includes(marker));
  const blockingMarker = CHALLENGE_BLOCKING_MARKERS.find(
    (candidate) => body.includes(candidate) || markers.includes(candidate),
  );
  const presentMarker = CHALLENGE_PRESENT_MARKERS.find(
    (candidate) => body.includes(candidate) || markers.includes(candidate),
  );
  const header = CHALLENGE_HEADERS.find((name) => hasHeader(signals.headers, name));

  if (!text && !blockingMarker && !presentMarker && !header) return undefined;
  const severity = text || blockingMarker || header ? "blocking" : "present";
  return {
    type: challengeFamily(
      `${body}\n${markers}`,
      blockingMarker ?? presentMarker ?? header ?? text ?? "",
    ),
    severity,
    evidence: [text, blockingMarker, presentMarker, header].filter((value): value is string =>
      Boolean(value),
    ),
  };
}

/** True when the body only works with JavaScript enabled. */
export function looksLikeJsShell(signals: ResponseSignals): boolean {
  if (!isHtml(signals.contentType, signals.body)) return false;
  const body = (signals.body ?? "").toLowerCase();
  return JS_SHELL_MARKERS.some((marker) => body.includes(marker));
}

/** True when the body is a consent wall rather than the requested content. */
export function looksLikeConsentWall(signals: ResponseSignals): boolean {
  const body = (signals.body ?? "").toLowerCase();
  if (!body || body.length > 20_000) return false;
  const matched = CONSENT_MARKERS.filter((marker) => body.includes(marker)).length;
  return matched >= 2;
}

/** Classify one response into the shared outcome vocabulary. */
export function classifyResponse(signals: ResponseSignals): ResponseClassification {
  const challenge = detectChallenge(signals);
  if (challenge?.severity === "blocking") {
    return {
      outcome: "challenge",
      reason: `challenge detected (${challenge.type})`,
      challenge,
    };
  }

  const retryAfterMs = retryAfterFromHeaders(signals.headers);

  if (signals.status === 429) {
    return throttled("rate limited", retryAfterMs);
  }
  if (signals.status === 503) {
    return throttled("service unavailable", retryAfterMs);
  }
  if (signals.status === 401 || signals.status === 403 || signals.status === 451) {
    return {
      outcome: "blocked-hard",
      reason: `HTTP ${signals.status} without challenge markers`,
    };
  }
  if (signals.status >= 400) {
    return { outcome: "http-error", reason: `HTTP ${signals.status}` };
  }
  if (looksLikeConsentWall(signals)) {
    return { outcome: "consent", reason: "consent wall" };
  }
  if (looksLikeJsShell(signals)) {
    return { outcome: "js-shell", reason: "page requires JavaScript" };
  }
  return { outcome: "ok" };
}

/**
 * Parse `Retry-After` in full: delay-seconds or an HTTP-date. Values are not
 * clamped; the caller decides whether the wait fits its budget.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Milliseconds requested by `Retry-After`, `RateLimit-Reset`, or `X-RateLimit-Reset`. */
export function retryAfterFromHeaders(
  headers: Headers | Record<string, string | undefined> | undefined,
  now = Date.now(),
): number | undefined {
  const retryAfter = parseRetryAfter(getHeader(headers, "retry-after"), now);
  if (retryAfter !== undefined) return retryAfter;

  const reset = getHeader(headers, "ratelimit-reset") ?? getHeader(headers, "rate-limit-reset");
  if (reset && /^\d+(?:\.\d+)?$/.test(reset.trim())) {
    return Math.max(0, Math.round(Number(reset) * 1000));
  }

  const epoch = getHeader(headers, "x-ratelimit-reset");
  if (epoch && /^\d+$/.test(epoch.trim())) {
    const at = Number(epoch) * 1000;
    // Ignore a header that is clearly not an epoch timestamp.
    return at > now ? at - now : undefined;
  }
  return undefined;
}

/** What to do about a throttled response. */
export type RetryPlan =
  | { action: "wait"; delayMs: number; reason: string }
  | { action: "fail"; delayMs: number; reason: string };

/**
 * Decide whether a requested delay fits the wait budget. A longer delay fails
 * fast with the retry time named, so the caller can route elsewhere instead of
 * stalling or retrying into the limit.
 */
export function planRetry(
  retryAfterMs: number | undefined,
  maxWaitMs: number,
  now = Date.now(),
): RetryPlan {
  const delayMs = retryAfterMs ?? DEFAULT_RETRY_DELAY_MS;
  if (delayMs > maxWaitMs) {
    return {
      action: "fail",
      delayMs,
      reason: `host asked to retry in ${formatDelay(delayMs)}, beyond the ${formatDelay(maxWaitMs)} wait cap (retry after ${new Date(now + delayMs).toISOString()})`,
    };
  }
  return { action: "wait", delayMs, reason: `host asked to wait ${formatDelay(delayMs)}` };
}

/** Human-facing delay, such as `2 minutes` or `45 seconds`. */
export function formatDelay(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function throttled(reason: string, retryAfterMs: number | undefined): ResponseClassification {
  return retryAfterMs === undefined
    ? { outcome: "throttled", reason }
    : { outcome: "throttled", reason, retryAfterMs };
}

function challengeFamily(body: string, fallback: string): string {
  const haystack = `${body}\n${fallback}`.toLowerCase();
  if (
    haystack.includes("cloudflare") ||
    haystack.includes("cf-challenge") ||
    haystack.includes("cf-mitigated") ||
    haystack.includes("challenge-platform")
  ) {
    return "cloudflare";
  }
  if (haystack.includes("anubis")) return "anubis";
  if (haystack.includes("recaptcha")) return "recaptcha";
  if (haystack.includes("hcaptcha") || haystack.includes("h-captcha")) return "hcaptcha";
  if (haystack.includes("perimeterx") || haystack.includes("px-captcha")) return "perimeterx";
  if (haystack.includes("datadome")) return "datadome";
  return "interstitial";
}

function isHtml(contentType: string | undefined, body: string | undefined): boolean {
  if (contentType) return /html|xhtml/i.test(contentType);
  return Boolean(body && /<html|<body|<div|<noscript/i.test(body.slice(0, 2_000)));
}

function hasHeader(
  headers: Headers | Record<string, string | undefined> | undefined,
  name: string,
): boolean {
  return getHeader(headers, name) !== undefined;
}

function getHeader(
  headers: Headers | Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | undefined>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : record[key];
}

function headerValues(headers: Headers | Record<string, string | undefined> | undefined): string[] {
  if (!headers) return [];
  if (typeof (headers as Headers).entries === "function") {
    return [...(headers as Headers).entries()].map(([name, value]) => `${name}: ${value}`);
  }
  return Object.entries(headers as Record<string, string | undefined>)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}: ${value}`);
}
