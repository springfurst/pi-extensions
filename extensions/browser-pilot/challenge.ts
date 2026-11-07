import type { Page } from "puppeteer-core";
import type { ChallengeInfo } from "./types";

/** The page signals used to classify a challenge. */
export interface ChallengeSignals {
  url: string;
  title: string;
  text: string;
  markers: string[];
}

const STRONG_TEXT = [
  "just a moment",
  "checking your browser",
  "verify you are human",
  "verifying you are human",
  "attention required",
  "access denied",
  "pardon our interruption",
  "request unsuccessful",
  "are you a robot",
  "please verify you are a human",
  "enable javascript and cookies to continue",
  "press & hold",
];

const CAPTCHA_MARKERS = ["recaptcha", "hcaptcha", "data-sitekey", "g-recaptcha", "h-captcha"];

const BLOCKING_MARKERS = [
  "challenge-form",
  "cf-challenge-running",
  "challenge-platform",
  "challenges.cloudflare.com",
  "px-captcha",
  "perimeterx",
  "datadome",
];

/** Classify page signals into a challenge, if any. Pure and testable. */
export function classifyChallenge(signals: ChallengeSignals): ChallengeInfo | undefined {
  const title = signals.title.toLowerCase();
  const text = signals.text.toLowerCase();
  const haystack = `${title}\n${text}`;
  const markers = signals.markers.map((marker) => marker.toLowerCase());

  const strongText = STRONG_TEXT.find((needle) => haystack.includes(needle));
  const blockingMarker = markers.find((marker) =>
    BLOCKING_MARKERS.some((needle) => marker.includes(needle)),
  );
  const captchaMarker = markers.find((marker) =>
    CAPTCHA_MARKERS.some((needle) => marker.includes(needle)),
  );

  if (strongText || blockingMarker) {
    const type = detectType(haystack, markers, blockingMarker);
    const evidence = [strongText, blockingMarker].filter((value): value is string => !!value);
    return {
      type,
      severity: "blocking",
      evidence,
      url: signals.url,
      title: signals.title,
    };
  }

  if (captchaMarker) {
    return {
      type: detectType(haystack, markers, captchaMarker),
      severity: "present",
      evidence: [captchaMarker],
      url: signals.url,
      title: signals.title,
    };
  }

  return undefined;
}

function detectType(haystack: string, markers: string[], marker: string | undefined): string {
  const all = `${haystack}\n${markers.join("\n")}`;
  if (
    all.includes("cloudflare") ||
    all.includes("challenge-platform") ||
    all.includes("cf-") ||
    all.includes("just a moment") ||
    all.includes("checking your browser")
  ) {
    return "cloudflare";
  }
  if (all.includes("recaptcha")) return "recaptcha";
  if (all.includes("hcaptcha")) return "hcaptcha";
  if (all.includes("perimeterx") || all.includes("px-captcha")) return "perimeterx";
  if (all.includes("datadome")) return "datadome";
  return marker ? "challenge" : "generic";
}

/** Read the challenge signals from a live page. */
export async function readChallengeSignals(page: Page): Promise<ChallengeSignals> {
  return page.evaluate(() => {
    const markers: string[] = [];
    const selectors = [
      "#challenge-form",
      "#cf-challenge-running",
      'script[src*="challenge-platform"]',
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      ".g-recaptcha",
      ".h-captcha",
      "[data-sitekey]",
      "#px-captcha",
      'script[src*="perimeterx"]',
      'script[src*="datadome"]',
    ];
    for (const selector of selectors) {
      if (document.querySelector(selector)) markers.push(selector);
    }
    return {
      url: location.href,
      title: document.title,
      text: (document.body?.innerText ?? "").slice(0, 4000),
      markers,
    };
  });
}

/** Detect a CAPTCHA or bot challenge on the page. */
export async function detectChallenge(page: Page): Promise<ChallengeInfo | undefined> {
  if (page.isClosed()) return undefined;
  try {
    return classifyChallenge(await readChallengeSignals(page));
  } catch {
    return undefined;
  }
}

export interface WaitForHumanOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (elapsedMs: number, challenge?: ChallengeInfo) => void;
}

export interface WaitForHumanResult {
  cleared: boolean;
  elapsedMs: number;
  challenge?: ChallengeInfo;
  initialChallenge?: ChallengeInfo;
}

/**
 * Wait for a human to clear a challenge in the visible window. Polls the page
 * for challenge markers and treats a URL change as a strong sign of progress.
 */
export async function waitForHuman(
  page: Page,
  options: WaitForHumanOptions,
): Promise<WaitForHumanResult> {
  const started = Date.now();
  const initialUrl = page.url();
  let challenge = await detectChallenge(page);
  const initialChallenge = challenge;
  if (!challenge || challenge.severity !== "blocking") {
    return { cleared: true, elapsedMs: 0, challenge, initialChallenge };
  }

  const deadline = started + options.timeoutMs;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    await sleep(1_000);
    options.onProgress?.(Date.now() - started, challenge);
    if (page.isClosed()) {
      return { cleared: false, elapsedMs: Date.now() - started, challenge };
    }
    challenge = await detectChallenge(page);
    if (!challenge || challenge.severity !== "blocking") {
      return { cleared: true, elapsedMs: Date.now() - started, challenge, initialChallenge };
    }
    if (page.url() !== initialUrl) {
      return { cleared: true, elapsedMs: Date.now() - started, challenge, initialChallenge };
    }
  }
  return { cleared: false, elapsedMs: Date.now() - started, challenge, initialChallenge };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
