import type { HTTPRequest, HTTPResponse } from "puppeteer-core";
import { finalize, hint, pageHeader, truncationHint } from "./output";
import { matchesUrlPattern } from "./route";
import type { BrowserPilotSession } from "./session";
import { formatBytes, indentText, sleep } from "./tool-helpers";
import type { BrowserPilotParams, BrowserPilotToolResult, NetworkEntry } from "./types";
import { BrowserPilotError } from "./types";

export const NETWORK_BODY_PREVIEW_CHARS = 4_000;
const MAX_NETWORK_BODY_BYTES = 2 * 1024 * 1024;

export async function networkResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
): Promise<BrowserPilotToolResult> {
  const tab = await session.ensureTab(params.tab);
  if (params.operation === "clear") {
    const count = session.clearNetwork(tab);
    return finalize(`Cleared ${count} network entries.`, {
      action: "network",
      op: "clear",
      tab: tab.handle,
      count,
    });
  }
  if (params.operation === "get") {
    return networkGetResult(params, session, tab);
  }
  const limit = params.limit ?? 100;
  const entries = tab.network
    .filter((entry) => !params.filter || entry.url.includes(params.filter))
    .slice(-limit);
  const pageUrl = tab.page.url();
  const lines = [
    pageHeader(tab.handle, pageUrl, await tab.page.title().catch(() => "")),
    networkSummary(tab.network),
  ];
  if (entries.length === 0) {
    lines.push("", "No network entries.");
  } else {
    lines.push("", ...entries.map((entry) => networkLine(entry, pageUrl)));
    lines.push(
      "",
      hint(
        'use {action:"network", params:{operation:"get", request_id:"r12"}} for headers and body.',
      ),
    );
  }
  return finalize(lines.join("\n"), {
    action: "network",
    op: "read",
    tab: tab.handle,
    url: pageUrl,
    count: entries.length,
    entries,
  });
}

export function networkSummary(entries: NetworkEntry[]): string {
  const failed = entries.filter((entry) => entry.failed).length;
  const pending = entries.filter((entry) => !entry.failed && entry.status === undefined).length;
  const ok = entries.length - failed - pending;
  const bytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  const size = bytes > 0 ? ` · ${formatBytes(bytes)}` : "";
  return `Network: ${entries.length} requests · ${ok} ok · ${failed} failed · ${pending} pending${size}`;
}

export function networkLine(entry: NetworkEntry, pageUrl: string): string {
  const status = entry.failed ? "FAIL" : (entry.status ?? "…");
  const meta = [
    entry.resourceType,
    entry.mimeType?.split(";")[0],
    entry.durationMs !== undefined ? `${entry.durationMs}ms` : undefined,
    entry.size !== undefined ? formatBytes(entry.size) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const failure = entry.failed ? ` · ${entry.failed}` : "";
  return `${entry.id} ${status} ${entry.method} ${compactNetworkUrl(entry.url, pageUrl)}${meta ? ` · ${meta}` : ""}${failure}`;
}

export function compactNetworkUrl(url: string, pageUrl: string): string {
  if (!/^https?:/i.test(url)) return url.length > 80 ? `${url.slice(0, 77)}...` : url;
  try {
    const target = new URL(url);
    const base = new URL(pageUrl);
    if (target.origin === base.origin) return `${target.pathname}${target.search}`;
    return `${target.host}${target.pathname}${target.search}`;
  } catch {
    return url;
  }
}

async function networkGetResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  currentTab: Awaited<ReturnType<BrowserPilotSession["ensureTab"]>>,
): Promise<BrowserPilotToolResult> {
  const id = params.request_id!;
  const found = session.findNetworkEntry(id);
  if (!found) {
    throw new BrowserPilotError(
      `No network entry with id ${id}.`,
      'Run {action:"network", params:{operation:"read"}} to see available ids.',
    );
  }
  const { tab, entry } = found;
  if (params.tab === undefined && tab.handle !== currentTab.handle) {
    throw new BrowserPilotError(
      `Network entry ${id} belongs to tab ${tab.handle}.`,
      `Pass tab:${tab.handle} to inspect it.`,
    );
  }
  const detail = session.networkDetail(id);
  const request = detail?.request;
  const response = detail?.response;
  const pageUrl = tab.page.url();
  const lines = [
    pageHeader(tab.handle, pageUrl, await tab.page.title().catch(() => "")),
    `${entry.id} · ${entry.status ?? "..."}${entry.statusText ? ` ${entry.statusText}` : ""} ${entry.method} ${entry.url}`,
    `Type: ${[entry.resourceType, entry.mimeType, entry.size !== undefined ? formatBytes(entry.size) : undefined, entry.durationMs !== undefined ? `${entry.durationMs}ms` : undefined].filter(Boolean).join(" · ") || "unknown"}`,
  ];
  const timing = formatNetworkTiming(entry.timing);
  if (timing) lines.push(timing);
  if (entry.failed) lines.push(`Failed: ${entry.failed}`);
  const requestHeaders = requestHeadersText(request);
  if (requestHeaders) lines.push("", "Request headers:", indentText(requestHeaders));
  const postData = requestPostData(request, entry.postData);
  if (postData) {
    lines.push("", "Request body:", indentText(postData.slice(0, NETWORK_BODY_PREVIEW_CHARS)));
    if (postData.length > NETWORK_BODY_PREVIEW_CHARS) {
      lines.push("", truncationHint(postData.length, NETWORK_BODY_PREVIEW_CHARS, undefined, false));
    }
  }
  const responseHeaders = responseHeadersText(response);
  if (responseHeaders) lines.push("", "Response headers:", indentText(responseHeaders));
  let bodyText: string | undefined;
  let bodyTruncated = false;
  if (params.include_body !== false) {
    const body = await readNetworkBody(
      session,
      entry,
      response,
      params.max_chars ?? NETWORK_BODY_PREVIEW_CHARS,
    );
    if (body.text !== undefined) {
      bodyText = body.text;
      bodyTruncated = body.truncated ?? false;
      lines.push("", "Body:", indentText(body.text));
      if (bodyTruncated) {
        lines.push(
          "",
          truncationHint(
            body.chars ?? body.text.length,
            params.max_chars ?? NETWORK_BODY_PREVIEW_CHARS,
            undefined,
            false,
          ),
        );
      }
    } else if (body.note) {
      lines.push("", `Body: ${body.note}`);
    }
  }
  return finalize(lines.join("\n"), {
    action: "network",
    op: "get",
    tab: tab.handle,
    url: pageUrl,
    title: await tab.page.title().catch(() => ""),
    id,
    entry,
    requestHeaders,
    responseHeaders,
    body: bodyText,
    truncated: bodyTruncated,
  });
}

export function formatNetworkTiming(timing: unknown): string | undefined {
  if (!timing || typeof timing !== "object") return undefined;
  const value = timing as Record<string, unknown>;
  const number = (key: string): number | undefined => {
    const candidate = value[key];
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
  };
  const sendStart = number("sendStart");
  const sendEnd = number("sendEnd");
  const receiveStart = number("receiveHeadersStart");
  const receiveEnd = number("receiveHeadersEnd");
  const parts: string[] = [];
  if (sendStart !== undefined && sendEnd !== undefined) {
    parts.push(`send ${Math.max(0, Math.round(sendEnd - sendStart))}ms`);
  }
  if (sendEnd !== undefined && receiveStart !== undefined) {
    parts.push(`wait ${Math.max(0, Math.round(receiveStart - sendEnd))}ms`);
  }
  if (receiveStart !== undefined && receiveEnd !== undefined) {
    parts.push(`receive ${Math.max(0, Math.round(receiveEnd - receiveStart))}ms`);
  }
  return parts.length > 0 ? `Timing: ${parts.join(" · ")}` : undefined;
}

function requestHeadersText(request: HTTPRequest | undefined): string | undefined {
  if (!request) return undefined;
  try {
    const headers = request.headers();
    const entries = Object.entries(headers);
    return entries.length > 0
      ? entries.map(([key, value]) => `${key}: ${value}`).join("\n")
      : undefined;
  } catch {
    return undefined;
  }
}

function responseHeadersText(response: HTTPResponse | undefined): string | undefined {
  if (!response) return undefined;
  try {
    const headers = response.headers();
    const entries = Object.entries(headers);
    return entries.length > 0
      ? entries.map(([key, value]) => `${key}: ${value}`).join("\n")
      : undefined;
  } catch {
    return undefined;
  }
}

function requestPostData(request: HTTPRequest | undefined, fallback?: string): string | undefined {
  if (!request) return fallback;
  try {
    return request.postData() ?? fallback;
  } catch {
    return fallback;
  }
}

export async function readNetworkBody(
  session: BrowserPilotSession,
  entry: NetworkEntry,
  response: HTTPResponse | undefined,
  maxChars: number,
): Promise<{ text?: string; truncated?: boolean; chars?: number; note?: string }> {
  const detail = session.networkDetail(entry.id);
  if (detail?.body !== undefined) {
    const truncated = detail.bodyTruncated === true || detail.body.length > maxChars;
    return { text: detail.body.slice(0, maxChars), truncated, chars: detail.body.length };
  }
  if (!response) {
    return { note: "not available; the response is no longer retained. Use har for full capture." };
  }
  let headers: Record<string, string>;
  try {
    headers = response.headers();
  } catch {
    headers = {};
  }
  const mime = headers["content-type"] ?? entry.mimeType ?? "";
  if (!isTextualMime(mime)) {
    return { note: `binary or unsupported type${mime ? ` (${mime})` : ""}` };
  }
  const length = Number.parseInt(headers["content-length"] ?? "", 10);
  if (Number.isFinite(length) && length > MAX_NETWORK_BODY_BYTES) {
    return { note: `too large (${formatBytes(length)}); use har for the full body` };
  }
  try {
    const text = await response.text();
    const cacheChars = Math.max(maxChars, NETWORK_BODY_PREVIEW_CHARS);
    session.cacheNetworkBody(entry.id, text.slice(0, cacheChars), text.length > cacheChars);
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars, chars: text.length };
  } catch (error) {
    return {
      note: `unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isTextualMime(value: string): boolean {
  const mime = value.split(";")[0].trim().toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript" ||
    mime === "application/x-www-form-urlencoded" ||
    mime === "application/graphql"
  );
}

export function matchesNetworkPattern(pattern: string, url: string): boolean {
  if (!pattern || pattern === "*") return true;
  if (pattern.includes("*")) return matchesUrlPattern(pattern, url);
  return url.includes(pattern);
}

export async function waitForNetworkResponse(
  tab: Awaited<ReturnType<BrowserPilotSession["ensureTab"]>>,
  pattern: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<NetworkEntry> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const matches = tab.network.filter(
      (entry) =>
        matchesNetworkPattern(pattern, entry.url) && (entry.status !== undefined || entry.failed),
    );
    if (matches.length > 0) return matches[matches.length - 1];
    await sleep(100);
  }
  throw new BrowserPilotError(
    `Timed out after ${Math.round(timeout / 1000)}s waiting for a response matching ${pattern}.`,
    'Run {action:"network", params:{operation:"read"}} to inspect captured requests, or raise timeout_ms.',
  );
}
