import { TOOL_VERSION } from "../../lib/version";
import type { NetworkEntry, TabInfo } from "./types";

export interface HarOptions {
  creator?: string;
  tabs?: TabInfo[];
}

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    cookies: unknown[];
    headersSize: number;
    bodySize: number;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: Array<{ name: string; value: string }>;
    cookies: unknown[];
    content: {
      size: number;
      mimeType: string;
      text?: string;
      encoding?: string;
      _truncated?: boolean;
    };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: {
    send: number;
    wait: number;
    receive: number;
  };
  serverIPAddress?: string;
  _resourceType?: string;
  _failed?: string;
}

/** Build a HAR 1.2 document from captured network entries. */
export function buildHar(
  entries: NetworkEntry[],
  options: HarOptions = {},
): Record<string, unknown> {
  const pages = (options.tabs ?? []).map((tab) => ({
    startedDateTime: new Date().toISOString(),
    id: `tab-${tab.handle}`,
    title: tab.title || tab.url,
    pageTimings: {},
  }));
  return {
    log: {
      version: "1.2",
      creator: {
        name: options.creator ?? "browser-pilot",
        version: TOOL_VERSION,
      },
      pages,
      entries: entries.map(toHarEntry),
    },
  };
}

function toHarEntry(entry: NetworkEntry): HarEntry {
  const url = safeUrl(entry.url);
  const requestHeaders = headerPairs(entry.requestHeaders);
  const responseHeaders = headerPairs(entry.responseHeaders);
  const body = entry.responseBody;
  const mimeType = entry.mimeType ?? "application/octet-stream";
  return {
    startedDateTime: entry.timestamp,
    time: entry.durationMs ?? 0,
    request: {
      method: entry.method,
      url: entry.url,
      httpVersion: "HTTP/1.1",
      headers: requestHeaders,
      queryString: [...url.searchParams.entries()].map(([name, value]) => ({ name, value })),
      cookies: [],
      headersSize: -1,
      bodySize: entry.postData?.length ?? 0,
      ...(entry.postData
        ? { postData: { mimeType: "application/x-www-form-urlencoded", text: entry.postData } }
        : {}),
    },
    response: {
      status: entry.status ?? 0,
      statusText: entry.statusText ?? "",
      httpVersion: "HTTP/1.1",
      headers: responseHeaders,
      cookies: [],
      content: {
        size: body?.length ?? entry.size ?? 0,
        mimeType,
        ...(body !== undefined ? { text: body } : {}),
        ...(entry.responseBodyTruncated ? { _truncated: true } : {}),
      },
      redirectURL: responseHeaders.find((header) => header.name.toLowerCase() === "location")?.value
        ? String(
            responseHeaders.find((header) => header.name.toLowerCase() === "location")?.value ?? "",
          )
        : "",
      headersSize: -1,
      bodySize: entry.size ?? body?.length ?? 0,
    },
    cache: {},
    timings: {
      send: 0,
      wait: entry.durationMs ?? 0,
      receive: 0,
    },
    ...(entry.resourceType ? { _resourceType: entry.resourceType } : {}),
    ...(entry.failed ? { _failed: entry.failed } : {}),
  };
}

function headerPairs(headers: Record<string, string> | undefined): Array<{
  name: string;
  value: string;
}> {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

function safeUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    return new URL("http://invalid/");
  }
}
