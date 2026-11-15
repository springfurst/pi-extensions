import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ElementHandle, Frame, KeyInput, Page } from "puppeteer-core";
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
  if (entry.tab !== tab.handle) {
    throw new BrowserPilotError(
      `Ref ${params.ref} belongs to tab ${entry.tab}, not tab ${tab.handle}.`,
      `Run {action:"snapshot", params:{tab:${tab.handle}}} to get refs for this tab.`,
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

/** Modifier spellings accepted in a key combination, mapped to Puppeteer key names. */
const KEY_MODIFIERS: Record<string, KeyInput> = {
  alt: "Alt",
  option: "Alt",
  control: "Control",
  ctrl: "Control",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  shift: "Shift",
};

export interface KeyCombo {
  modifiers: KeyInput[];
  key: KeyInput;
}

/** Split a combination such as `Control+Shift+A` into modifiers and a base key. */
export function parseKeyCombo(combo: string): KeyCombo {
  const parts = combo
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const key = parts.pop();
  if (!key) {
    throw new BrowserPilotError(
      "press requires a key.",
      'Example: {action:"press", params:{key:"Enter"}} or {action:"press", params:{key:"Control+A"}}',
    );
  }
  const modifiers: KeyInput[] = [];
  for (const part of parts) {
    const modifier = KEY_MODIFIERS[part.toLowerCase()];
    if (!modifier) {
      throw new BrowserPilotError(
        `Unknown modifier "${part}" in "${combo}".`,
        'Use Control, Shift, Alt, or Meta, such as "Control+A".',
      );
    }
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  return { modifiers, key: key as KeyInput };
}

/** Press a key or key combination such as `Control+A`. */
export async function pressKeyCombo(page: Page, combo: string): Promise<void> {
  const { modifiers, key } = parseKeyCombo(combo);
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  try {
    await page.keyboard.press(key);
  } catch {
    throw new BrowserPilotError(
      `Unknown key "${key}" in "${combo}".`,
      'Use a key name such as "Enter", "Escape", "Tab", "ArrowDown", or a single character.',
    );
  } finally {
    for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
  }
}

/**
 * Describe an element as `role "name"`, matching the names snapshots use, so a click or a type can
 * say what it touched. Returns undefined when the element is gone.
 */
export async function describeElement(handle: ElementHandle): Promise<string | undefined> {
  try {
    return await handle.evaluate((element) => {
      const el = element as HTMLElement;
      const clean = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 60);
      const tag = el.tagName.toLowerCase();
      const type = el instanceof HTMLInputElement ? el.type : undefined;
      const role = (() => {
        if (tag === "a") return "link";
        if (tag === "img") return "image";
        if (/^h[1-6]$/.test(tag)) return "heading";
        if (tag === "select") return "combobox";
        if (tag === "textarea") return "textbox";
        if (tag !== "input") return tag;
        if (type === "checkbox" || type === "radio" || type === "file") return type;
        if (type === "button" || type === "submit" || type === "reset") return "button";
        if (type === "search") return "searchbox";
        if (type === "number" || type === "range") return "slider";
        return "textbox";
      })();
      const name = (() => {
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel?.trim()) return ariaLabel;
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement
        ) {
          // A label wraps its control, so drop the control and any option text it carries.
          const labels = Array.from(el.labels ?? [])
            .map((label) => {
              const clone = label.cloneNode(true) as HTMLElement;
              for (const child of Array.from(
                clone.querySelectorAll("input, select, textarea, button, option"),
              )) {
                child.remove();
              }
              return clone.textContent ?? "";
            })
            .join(" ");
          if (labels.trim()) return labels;
          if (el instanceof HTMLSelectElement) {
            const selected = Array.from(el.selectedOptions)
              .map((option) => option.textContent ?? "")
              .join(", ");
            if (selected.trim()) return selected;
          } else if (el.placeholder) {
            return el.placeholder;
          }
          if (el instanceof HTMLInputElement && el.value && el.type !== "password") {
            return el.value;
          }
        }
        for (const attribute of ["alt", "title"]) {
          const value = el.getAttribute(attribute);
          if (value?.trim()) return value;
        }
        return el.innerText ?? el.textContent ?? "";
      })();
      const label = clean(name);
      if (label) return `${role} "${label}"`;
      if (tag === "input" && type) return `input[type=${type}]`;
      return role;
    });
  } catch {
    return undefined;
  }
}

/** One option of a select element, as read from the page. */
export interface SelectOptionInfo {
  value: string;
  label: string;
  text: string;
}

/** Map requested option values or labels onto option values, reporting unmatched requests. */
export function resolveSelectValues(
  options: SelectOptionInfo[],
  requested: string[],
): { values: string[]; missing: string[] } {
  const values: string[] = [];
  const missing: string[] = [];
  for (const request of requested) {
    const match =
      options.find((option) => option.value === request) ??
      options.find((option) => option.label === request) ??
      options.find((option) => option.text.trim() === request.trim());
    if (!match) {
      missing.push(request);
      continue;
    }
    if (!values.includes(match.value)) values.push(match.value);
  }
  return { values, missing };
}

/** Read the options of a select element. */
export async function selectOptionInfo(
  handle: ElementHandle<HTMLSelectElement>,
): Promise<SelectOptionInfo[]> {
  return handle.evaluate((element) =>
    Array.from((element as HTMLSelectElement).options).map((option) => ({
      value: option.value,
      label: option.label,
      text: option.textContent ?? "",
    })),
  );
}

export function appendChallenge(lines: string[], challenge: ChallengeInfo | undefined): void {
  if (!challenge) return;
  lines.push("", formatChallenge(challenge)!);
  if (challenge.severity === "blocking") {
    lines.push(
      hint('solve it in the Chrome window, then run {action:"wait", params:{until:"human"}}.'),
    );
  }
}
