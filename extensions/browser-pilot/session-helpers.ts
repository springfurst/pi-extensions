import { basename } from "node:path";
import type { HTTPRequest, HTTPResponse, Page } from "puppeteer-core";
import { resolveProfile } from "./launcher";
import type { BrowserPilotConfig, ProfileInfo } from "./types";
import { BrowserPilotError } from "./types";

export function targetIdOf(page: Page): string {
  const target = page.target() as unknown as { _targetId?: string };
  return target._targetId ?? page.url();
}

export function platformToken(): string {
  if (process.platform === "win32") return "Windows NT 10.0; Win64; x64";
  if (process.platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  return "X11; Linux x86_64";
}

export function safeResourceType(request: HTTPRequest): string | undefined {
  try {
    return request.resourceType();
  } catch {
    return undefined;
  }
}

export function headerValue(response: HTTPResponse, name: string): string | undefined {
  try {
    return response.headers()[name];
  } catch {
    return undefined;
  }
}

export function trim<T>(items: T[], limit: number): void {
  while (items.length > limit) items.shift();
}

export async function resolveDevToolsEndpoint(endpoint: string): Promise<string> {
  const trimmed = endpoint.trim();
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (/^wss?:\/\//i.test(withScheme)) return withScheme;
  if (!/^https?:\/\//i.test(withScheme)) {
    throw new BrowserPilotError(
      `Unsupported endpoint scheme: ${endpoint}`,
      "Use a ws:// DevTools endpoint or an http:// endpoint exposing /json/version.",
    );
  }
  const base = withScheme.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${base}/json/version`);
  } catch (error) {
    throw new BrowserPilotError(
      `Could not reach ${base}: ${error instanceof Error ? error.message : String(error)}`,
      "Check that Chrome is running with --remote-debugging-port and the port is reachable.",
    );
  }
  if (!response.ok) {
    throw new BrowserPilotError(
      `DevTools endpoint ${base}/json/version returned ${response.status}.`,
    );
  }
  const data = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof data.webSocketDebuggerUrl !== "string") {
    throw new BrowserPilotError(`DevTools endpoint ${base} did not return a websocket URL.`);
  }
  return data.webSocketDebuggerUrl;
}

export function safeFilename(value: string): string {
  const cleaned = Array.from(basename(value))
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  return cleaned || `download-${Date.now()}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function sanitizeFile(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80) || `session-${process.pid}`;
}

/** Resolve the profile a session would use without launching a browser. */
export function previewProfile(
  config: BrowserPilotConfig,
  sessionId: string,
  agentDir: string,
  cwd: string,
): ProfileInfo {
  return resolveProfile(config.profile, sessionId, agentDir, cwd);
}
