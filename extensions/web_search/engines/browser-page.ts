// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import type { BrowserRenderer } from "../../../lib/browser";

/** HTML plus the response status and final URL after browser navigation. */
export interface BrowserLoadedPage {
  html: string;
  status: number;
  url: string;
}

/** Upper bound on the post-navigation wait for a result selector. */
export const RESULT_RENDER_TIMEOUT_MS = 10_000;

export interface LoadBrowserPageOptions {
  renderPage: BrowserRenderer;
  signal?: AbortSignal;
  timeoutMs: number;
  /** Warm cookies by navigating here before the search URL. */
  homeUrl?: string;
  /** Wait for this selector after navigation, then proceed regardless. */
  readySelector?: string;
  readyTimeoutMs?: number;
}

/**
 * Load one search results page through the shared browser renderer. The
 * renderer owns navigation, request interception, and lifecycle; this wrapper
 * only names the search-specific options and normalizes the result shape.
 */
export async function loadBrowserPage(
  url: string,
  options: LoadBrowserPageOptions,
): Promise<BrowserLoadedPage> {
  const page = await options.renderPage(url, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    homeUrl: options.homeUrl,
    readySelector: options.readySelector,
    readyTimeoutMs: options.readyTimeoutMs ?? RESULT_RENDER_TIMEOUT_MS,
  });
  return { html: page.html, status: page.status, url: page.finalUrl };
}
