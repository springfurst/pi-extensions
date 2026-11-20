// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

/**
 * The HTTP transport behind every web-call site.
 *
 * One request walks the SSRF guard on every hop, follows redirects manually,
 * sends one honest identity, consults `robots.txt`, spends the pacing budget,
 * classifies the response, and retries a throttled request once when the host's
 * delay fits the wait budget. Higher layers decide what the bytes mean.
 */

import { DEFAULT_MAX_BYTES } from "../config";
import { normalizeMime, readLimitedBytes, readLimitedText, withHardTimeout } from "../http";
import { checkUrlAllowed, type ResolveHost } from "../security";
import { systemClock } from "./clock";
import { classifyResponse, formatDelay, planRetry } from "./outcome";
import type { Politeness } from "./politeness";
import { robotsAllows, robotsIntervalMs, robotsTxtUrl } from "./robots";
import type { ChallengeSummary, Outcome } from "./types";
import { DEFAULT_USER_AGENT, identityHeaders, productToken } from "./user-agent";

export type FetchImpl = typeof fetch;

export interface TransferOptions {
  timeoutSeconds?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  maxBytes?: number;
  signal?: AbortSignal;
  fetch?: FetchImpl;
  allowPrivateHosts?: boolean;
  resolve?: ResolveHost;
  /** Pacing, robots, and identity policy; absent skips all of it. */
  politeness?: Politeness;
  /** `Cookie` header supplied by a warm profile, when one is available. */
  cookies?: string;
}

export interface TransferResult {
  content: string;
  contentType: string;
  finalUrl: string;
  ok: boolean;
  status?: number;
  /** True when the body was cut at the byte cap. */
  truncated?: boolean;
  /** Last transport-level error when `ok` is false. */
  error?: string;
  /** Notes worth surfacing to the caller, such as a robots warning. */
  notes?: string[];
  /** Delay the host asked for, in milliseconds. */
  retryAfterMs?: number;
  /** Classification of the response. */
  outcome?: Outcome;
  /** Classifier output when the outcome is `challenge`. */
  challenge?: ChallengeSummary;
}

const MAX_REDIRECTS = 10;
const ROBOTS_MAX_BYTES = 512 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/** Drop credential-bearing headers, matching the Fetch standard for cross-origin redirects. */
function dropCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) next[name] = value;
  }
  return next;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function pathAndQueryOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

interface RequestIdentity {
  userAgent: string;
  contact?: string;
}

interface AttemptArgs {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
  cookies?: string;
  identity: RequestIdentity;
  timeoutSeconds: number;
  maxBytes: number;
  maxRetryWaitMs: number;
  fetchImpl: FetchImpl;
  signal?: AbortSignal;
  allowPrivateHosts: boolean;
  resolve?: ResolveHost;
  politeness?: Politeness;
  /** False once the single throttle retry has been spent. */
  allowRetry: boolean;
  notes: string[];
}

type AttemptOutcome =
  { kind: "response"; result: TransferResult } | { kind: "retry"; delayMs: number };

/**
 * Fetch a URL once, with the SSRF guard on every hop, manual redirect
 * following, one honest user agent, host pacing, `robots.txt` handling, a
 * streamed byte cap, charset decoding, and one `Retry-After`-aware retry.
 */
export async function transfer(
  url: string,
  options: TransferOptions = {},
): Promise<TransferResult> {
  const timeoutSeconds = options.timeoutSeconds ?? 30;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetchImpl = options.fetch ?? fetch;
  const signal = options.signal;
  const allowPrivateHosts = options.allowPrivateHosts ?? false;
  const resolve = options.resolve;
  const politeness = options.politeness;
  const identity: RequestIdentity = {
    userAgent: politeness?.config.userAgent ?? DEFAULT_USER_AGENT,
    contact: politeness?.config.contact,
  };
  const maxRetryWaitMs = (politeness?.config.maxRetryWaitSeconds ?? 30) * 1000;
  const notes: string[] = [];

  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const outcome = await attemptOnce({
        url,
        method: options.method ?? "GET",
        body: options.body,
        headers: options.headers ?? {},
        cookies: options.cookies,
        identity,
        timeoutSeconds,
        maxBytes,
        maxRetryWaitMs,
        fetchImpl,
        signal,
        allowPrivateHosts,
        resolve,
        politeness,
        allowRetry: attempt === 0,
        notes,
      });
      if (outcome.kind === "retry") {
        await systemClock.sleep(outcome.delayMs, signal);
        continue;
      }
      return outcome.result;
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      return failure(url, "", undefined, message, notes);
    }
  }
}

async function attemptOnce(args: AttemptArgs): Promise<AttemptOutcome> {
  let currentUrl = args.url;
  let method = args.method;
  let body = args.body;
  let headers = { ...args.headers };
  let previousOrigin = originOf(currentUrl);
  const fail = (
    finalUrl: string,
    contentType: string,
    status: number | undefined,
    error: string,
    extra: Partial<TransferResult> = {},
  ): AttemptOutcome => ({
    kind: "response",
    result: failure(finalUrl, contentType, status, error, args.notes, extra),
  });

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    args.signal?.throwIfAborted();

    const guard = await checkUrlAllowed(currentUrl, {
      allowPrivateHosts: args.allowPrivateHosts,
      resolve: args.resolve,
    });
    if (!guard.allowed) {
      return fail(currentUrl, "", undefined, guard.reason ?? "blocked by the URL guard");
    }

    const host = hostOf(currentUrl);
    const origin = originOf(currentUrl);
    let minIntervalMs = 0;

    if (args.politeness && origin) {
      const rules = await args.politeness.robots.rules(
        origin,
        () => fetchRobots(origin, args),
        productToken(args.identity.userAgent),
      );
      const path = pathAndQueryOf(currentUrl);
      const decision = robotsAllows(rules, path);
      const mode = args.politeness.store.policyFor(host)?.robots ?? args.politeness.config.robots;
      if (decision.matched && !decision.allowed) {
        if (mode === "strict") {
          return fail(
            currentUrl,
            "",
            undefined,
            `robots.txt disallows ${path} on ${host} (rule: ${decision.rule})`,
          );
        }
        if (args.politeness.robots.noteWarned(origin)) {
          args.notes.push(
            `robots.txt disallows ${path} on ${host} (rule: ${decision.rule}); fetched anyway because politeness.robots is "warn"`,
          );
        }
      }
      minIntervalMs = Math.max(
        args.politeness.store.intervalMs(host),
        robotsIntervalMs(rules) ?? 0,
      );

      const blockedForMs = args.politeness.store.remainingBlockMs(host);
      if (blockedForMs > 0) {
        if (blockedForMs > args.maxRetryWaitMs) {
          return fail(
            currentUrl,
            "",
            undefined,
            `${host} asked us to back off for ${formatDelay(blockedForMs)}, beyond the ${formatDelay(args.maxRetryWaitMs)} wait cap`,
          );
        }
        await systemClock.sleep(blockedForMs, args.signal);
      }
    }

    const latencyStarted = Date.now();
    const send = () =>
      args.fetchImpl(currentUrl, {
        signal: withHardTimeout(args.signal, args.timeoutSeconds * 1000),
        method,
        headers: {
          ...identityHeaders(args.identity),
          ...(args.cookies ? { Cookie: args.cookies } : {}),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          // Cloudflare's Markdown-for-Agents returns corrupted bytes with compression.
          "Accept-Encoding": "identity",
          ...headers,
        },
        redirect: "manual",
        body,
      });
    const response = args.politeness
      ? await args.politeness.limiter.schedule({ host, minIntervalMs, signal: args.signal }, send)
      : await send();
    const latencyMs = Date.now() - latencyStarted;

    const rawContentType = response.headers.get("content-type") ?? "";
    const contentType = normalizeMime(rawContentType);
    const finalUrl = response.url || currentUrl;

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        return fail(
          finalUrl,
          contentType,
          response.status,
          `Redirect without Location from ${currentUrl}`,
        );
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        return fail(finalUrl, contentType, response.status, `Invalid redirect target: ${location}`);
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return fail(
          finalUrl,
          contentType,
          response.status,
          `Unsupported redirect scheme: ${next.protocol}`,
        );
      }
      // 301/302/303 downgrade a non-idempotent method to GET, matching browsers.
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method !== "GET" &&
          method !== "HEAD")
      ) {
        method = "GET";
        body = undefined;
      }
      if (previousOrigin !== undefined && next.origin !== previousOrigin) {
        headers = dropCredentialHeaders(headers);
      }
      previousOrigin = next.origin;
      currentUrl = next.href;
      continue;
    }

    const { bytes, truncated } = await readLimitedBytes(response, args.maxBytes);
    const content = decodeBody(bytes, rawContentType);
    const classification = classifyResponse({
      status: response.status,
      headers: response.headers,
      body: content,
      contentType,
    });

    if (classification.outcome === "throttled") {
      const plan = planRetry(classification.retryAfterMs, args.maxRetryWaitMs);
      args.politeness?.store.noteThrottle(host, plan.delayMs);
      if (plan.action === "fail") {
        return fail(
          finalUrl,
          contentType,
          response.status,
          `HTTP ${response.status}: ${plan.reason}`,
          {
            retryAfterMs: plan.delayMs,
            outcome: classification.outcome,
          },
        );
      }
      if (!args.allowRetry) {
        return fail(
          finalUrl,
          contentType,
          response.status,
          `HTTP ${response.status}: still ${classification.reason}`,
          { retryAfterMs: plan.delayMs, outcome: classification.outcome },
        );
      }
      return { kind: "retry", delayMs: plan.delayMs };
    }

    if (!response.ok) {
      const extra: Partial<TransferResult> = {
        truncated,
        outcome: classification.outcome,
      };
      if (classification.challenge) extra.challenge = classification.challenge;
      return fail(
        finalUrl,
        contentType,
        response.status,
        classification.challenge
          ? `HTTP ${response.status}: ${classification.reason}`
          : `HTTP ${response.status}`,
        extra,
      );
    }

    if (args.politeness && classification.outcome === "ok") {
      const update = args.politeness.store.noteSuccess(host, latencyMs);
      if (update.warningRaised) {
        args.notes.push(
          `Latency on ${host} rose above ${args.politeness.config.latencyWarningFactor}x its baseline; spacing raised to ${update.intervalMs} ms`,
        );
      }
    }

    return {
      kind: "response",
      result: {
        content,
        contentType,
        finalUrl,
        ok: true,
        status: response.status,
        truncated,
        outcome: classification.outcome,
        notes: args.notes.length > 0 ? [...args.notes] : undefined,
      },
    };
  }

  return {
    kind: "response",
    result: failure(currentUrl, "", undefined, `Too many redirects (${MAX_REDIRECTS})`, args.notes),
  };
}

/**
 * Read one origin's `robots.txt`. The read is cached per origin for an hour and
 * never consults the file itself, so it stays outside the pacing budget.
 */
async function fetchRobots(origin: string, args: AttemptArgs): Promise<string | undefined> {
  const target = robotsTxtUrl(origin);
  if (!target) return undefined;
  const guard = await checkUrlAllowed(target, {
    allowPrivateHosts: args.allowPrivateHosts,
    resolve: args.resolve,
  });
  if (!guard.allowed) return undefined;
  const response = await args.fetchImpl(target, {
    signal: withHardTimeout(args.signal, args.timeoutSeconds * 1000),
    headers: {
      ...identityHeaders(args.identity),
      Accept: "text/plain,*/*;q=0.8",
      "Accept-Encoding": "identity",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const { text } = await readLimitedText(response, ROBOTS_MAX_BYTES);
  return text;
}

function failure(
  finalUrl: string,
  contentType: string,
  status: number | undefined,
  error: string,
  notes: string[],
  extra: Partial<TransferResult> = {},
): TransferResult {
  return {
    content: "",
    contentType,
    finalUrl,
    ok: false,
    status,
    error,
    notes: notes.length > 0 ? [...notes] : undefined,
    ...extra,
  };
}

function charsetFromContentType(header: string): string | undefined {
  return /charset\s*=\s*"?([\w-]+)"?/i.exec(header)?.[1];
}

/**
 * Decode a body honoring the declared charset (Content-Type, then a bounded
 * `<meta charset>` sniff), falling back to UTF-8.
 */
function decodeBody(bytes: Uint8Array, contentTypeHeader: string): string {
  let label = charsetFromContentType(contentTypeHeader);
  if (!label) {
    const prefix = Buffer.from(bytes.subarray(0, 2048)).toString("latin1");
    label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(prefix)?.[1];
  }
  if (label && !/^utf-8$/i.test(label)) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Unknown label — fall back to UTF-8.
    }
  }
  return new TextDecoder().decode(bytes);
}
