// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { DEFAULT_MAX_BYTES } from "../../lib/config";
import { normalizeMime, readLimitedBytes, withHardTimeout } from "../../lib/http";
import { checkUrlAllowed } from "../../lib/security";
import type { FetchImpl, LoadPageOptions, LoadPageResult, ResolveHost } from "./types";

export const USER_AGENTS = [
  "curl/8.0",
  "Mozilla/5.0 (compatible; TextBot/1.0)",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

const MAX_REDIRECTS = 10;
const RETRY_AFTER_MAX_MS = 10_000;
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

interface AttemptArgs {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
  userAgent: string;
  timeoutSeconds: number;
  maxBytes: number;
  fetchImpl: FetchImpl;
  signal?: AbortSignal;
  allowPrivateHosts: boolean;
  resolve?: ResolveHost;
  retried429: boolean;
}

type AttemptOutcome = { kind: "response"; result: LoadPageResult } | { kind: "retry429" };

/**
 * Fetch a URL with rotating user agents, manual redirect following (re-running
 * the SSRF guard on every hop), one `Retry-After`-aware 429 retry, bot-block
 * retry, a streamed byte cap, and charset decoding.
 */
export async function loadPage(
  url: string,
  options: LoadPageOptions = {},
): Promise<LoadPageResult> {
  const timeoutSeconds = options.timeoutSeconds ?? 30;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetchImpl = options.fetch ?? fetch;
  const signal = options.signal;
  const allowPrivateHosts = options.allowPrivateHosts ?? false;
  const resolve = options.resolve;

  let lastError: string | undefined;
  let retried429 = false;

  for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
    signal?.throwIfAborted();
    try {
      const outcome = await attemptOnce({
        url,
        method: options.method ?? "GET",
        body: options.body,
        headers: options.headers ?? {},
        userAgent: USER_AGENTS[attempt]!,
        timeoutSeconds,
        maxBytes,
        fetchImpl,
        signal,
        allowPrivateHosts,
        resolve,
        retried429,
      });
      if (outcome.kind === "retry429") {
        retried429 = true;
        attempt--;
        continue;
      }
      const retryable =
        outcome.result.status === 403 ||
        isBotBlocked(outcome.result.status, outcome.result.content);
      if (retryable && attempt < USER_AGENTS.length - 1) {
        continue;
      }
      return outcome.result;
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return { content: "", contentType: "", finalUrl: url, ok: false, error: lastError };
}

async function attemptOnce(args: AttemptArgs): Promise<AttemptOutcome> {
  let currentUrl = args.url;
  let method = args.method;
  let body = args.body;
  let headers = { ...args.headers };
  let previousOrigin = originOf(currentUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    args.signal?.throwIfAborted();

    const guard = await checkUrlAllowed(currentUrl, {
      allowPrivateHosts: args.allowPrivateHosts,
      resolve: args.resolve,
    });
    if (!guard.allowed) {
      return {
        kind: "response",
        result: {
          content: "",
          contentType: "",
          finalUrl: currentUrl,
          ok: false,
          error: guard.reason,
        },
      };
    }

    const requestSignal = withHardTimeout(args.signal, args.timeoutSeconds * 1000);
    const response = await args.fetchImpl(currentUrl, {
      signal: requestSignal,
      method,
      headers: {
        "User-Agent": args.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        // Cloudflare's Markdown-for-Agents returns corrupted bytes with compression.
        "Accept-Encoding": "identity",
        ...headers,
      },
      redirect: "manual",
      body,
    });

    const rawContentType = response.headers.get("content-type") ?? "";
    const contentType = normalizeMime(rawContentType);
    const finalUrl = response.url || currentUrl;

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        return {
          kind: "response",
          result: {
            content: "",
            contentType,
            finalUrl,
            ok: false,
            status: response.status,
            error: `Redirect without Location from ${currentUrl}`,
          },
        };
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        return {
          kind: "response",
          result: {
            content: "",
            contentType,
            finalUrl,
            ok: false,
            status: response.status,
            error: `Invalid redirect target: ${location}`,
          },
        };
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return {
          kind: "response",
          result: {
            content: "",
            contentType,
            finalUrl,
            ok: false,
            status: response.status,
            error: `Unsupported redirect scheme: ${next.protocol}`,
          },
        };
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

    if (response.status === 429 && !args.retried429) {
      const delayMs = parseRetryAfterMs(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => undefined);
      await sleep(delayMs, args.signal);
      return { kind: "retry429" };
    }

    const { bytes, truncated } = await readLimitedBytes(response, args.maxBytes);
    const content = decodeBody(bytes, rawContentType);
    if (!response.ok) {
      return {
        kind: "response",
        result: {
          content,
          contentType,
          finalUrl,
          ok: false,
          status: response.status,
          truncated,
          error: `HTTP ${response.status}`,
        },
      };
    }
    return {
      kind: "response",
      result: { content, contentType, finalUrl, ok: true, status: response.status, truncated },
    };
  }

  return {
    kind: "response",
    result: {
      content: "",
      contentType: "",
      finalUrl: currentUrl,
      ok: false,
      error: `Too many redirects (${MAX_REDIRECTS})`,
    },
  };
}

/** Parse a `Retry-After` header (seconds or HTTP-date) into a bounded delay. */
export function parseRetryAfterMs(value: string | null): number {
  if (!value) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, RETRY_AFTER_MAX_MS);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), RETRY_AFTER_MAX_MS);
  return 1_000;
}

/** True when a 403/503 body looks like an anti-bot challenge rather than real content. */
export function isBotBlocked(status: number | undefined, content: string): boolean {
  if (status !== 403 && status !== 503) return false;
  const lower = content.toLowerCase();
  return (
    lower.includes("cloudflare") ||
    lower.includes("captcha") ||
    lower.includes("challenge") ||
    lower.includes("blocked") ||
    lower.includes("access denied") ||
    lower.includes("bot detection")
  );
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
  if (label && !/^utf-?8$/i.test(label)) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Unknown label — fall back to UTF-8.
    }
  }
  return new TextDecoder().decode(bytes);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
