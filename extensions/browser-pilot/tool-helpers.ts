import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Frame, Page } from "puppeteer-core";
import { expandTilde } from "../../lib/logging";
import { formatChallenge, hint } from "./output";
import type { BrowserPilotSession } from "./session";
import { refSelector } from "./snapshot";
import type { BrowserPilotParams, ChallengeInfo } from "./types";
import { BrowserPilotError } from "./types";

const MAX_INPUT_FILE_BYTES = 1024 * 1024;

/** Resolve a user path against the working directory, expanding a leading `~`. */
export function resolvePath(cwd: string, path: string): string {
  const expanded = expandTilde(path);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/** A filesystem-safe timestamp for generated exports. */
export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Remove the page header that individual actions prepend to their result. */
export function stripPageHeader(text: string): string {
  return text.replace(/^Tab \d+ · [^\n]*(?:\n|$)/, "");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function indentText(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** Resolve a ref to its owning page or frame. */
export function targetFor(
  session: BrowserPilotSession,
  tab: Awaited<ReturnType<BrowserPilotSession["ensureTab"]>>,
  params: BrowserPilotParams,
): Page | Frame {
  if (!params.ref) return tab.page;
  const entry = session.refs.get(params.ref);
  if (!entry) {
    throw new BrowserPilotError(
      `Ref ${params.ref} is not known in this snapshot.`,
      'Run {action:"snapshot"} to get fresh refs.',
    );
  }
  if (entry.frame?.isDetached()) {
    throw new BrowserPilotError(
      `The frame for ref ${params.ref} is detached.`,
      'Run {action:"snapshot"} again to get refs in the current page.',
    );
  }
  return entry.frame ?? tab.page;
}

export function resolveTargetSelector(params: BrowserPilotParams): string {
  if (params.ref) {
    const selector = refSelector(params.ref);
    if (!selector) {
      throw new BrowserPilotError(
        `Invalid ref "${params.ref}".`,
        'Refs look like e12. Run {action:"snapshot"} to get fresh refs.',
      );
    }
    return selector;
  }
  if (params.selector) return params.selector;
  throw new BrowserPilotError(
    "This action requires ref or selector.",
    'Run {action:"snapshot"} to get refs.',
  );
}

export function targetLabel(params: BrowserPilotParams): string {
  if (params.ref) return `ref ${params.ref}`;
  if (params.selector) return `selector ${params.selector}`;
  return "the target";
}

export function locatorFor(
  session: BrowserPilotSession,
  tab: Awaited<ReturnType<BrowserPilotSession["ensureTab"]>>,
  params: BrowserPilotParams,
  timeout: number,
) {
  const selector = resolveTargetSelector(params);
  return targetFor(session, tab, params).locator(selector).setTimeout(timeout);
}

export function resolveTypedText(params: BrowserPilotParams, cwd: string, action = "type"): string {
  if (params.text !== undefined) return params.text;
  if (params.text_file) return readInputFile(cwd, params.text_file);
  if (params.text_env) {
    const value = process.env[params.text_env];
    if (value === undefined) {
      throw new BrowserPilotError(
        `Environment variable ${params.text_env} is not set.`,
        `Set it in the environment before calling ${action}, or pass text directly.`,
      );
    }
    return value;
  }
  throw new BrowserPilotError(`${action} requires text, text_file, or text_env.`);
}

export function readInputFile(cwd: string, path: string): string {
  const absolute = resolvePath(cwd, path);
  try {
    const size = statSync(absolute).size;
    if (size > MAX_INPUT_FILE_BYTES) {
      throw new BrowserPilotError(
        `Input file is ${size} bytes, above the ${MAX_INPUT_FILE_BYTES} byte cap.`,
        "Pass a smaller file or use an inline expression.",
      );
    }
    return readFileSync(absolute, "utf-8");
  } catch (error) {
    if (error instanceof BrowserPilotError) throw error;
    throw new BrowserPilotError(
      `Could not read ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      "Check that the file exists and is readable.",
    );
  }
}

export function appendChallenge(lines: string[], challenge: ChallengeInfo | undefined): void {
  if (!challenge) return;
  lines.push("", formatChallenge(challenge)!);
  if (challenge.severity === "blocking") {
    lines.push(hint('solve it in the Chrome window, then run {action:"wait", for:"human"}.'));
  }
}
