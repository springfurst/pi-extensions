import type { Frame, Page } from "puppeteer-core";
import { htmlToBasicMarkdown } from "../../lib/markdown";
import { readabilityToMarkdown, stripDataUriImages } from "../../lib/readability";
import { BrowserPilotError } from "./types";

export type ContentFormat = "markdown" | "text" | "html" | "outline";

export interface ReadContentOptions {
  format: ContentFormat;
  selector?: string;
}

export interface ReadContentResult {
  text: string;
  format: ContentFormat;
  chars: number;
}

/** Read the live page as markdown, text, HTML, or a compact structural outline. */
export async function readPageContent(
  target: Page | Frame,
  options: ReadContentOptions,
): Promise<ReadContentResult> {
  let text: string;
  if (options.selector) {
    const element = await readElement(target, options.selector);
    if (options.format === "html") {
      text = element.html;
    } else if (options.format === "text") {
      text = element.text;
    } else if (options.format === "outline") {
      text = await outlineElement(target, options.selector);
    } else {
      text = readabilityToMarkdown(element.html) ?? htmlToBasicMarkdown(element.html);
    }
  } else if (options.format === "html") {
    text = await target.content();
  } else if (options.format === "text") {
    text = await target.evaluate(() => document.body?.innerText ?? "");
  } else if (options.format === "outline") {
    text = await target.evaluate(buildOutline, null, 200);
  } else {
    const html = await target.content();
    text = readabilityToMarkdown(html) ?? "";
    if (text.length < 100) text = htmlToBasicMarkdown(html);
    if (!text) text = await target.evaluate(() => document.body?.innerText ?? "");
  }

  const cleaned = stripDataUriImages(text).trim();
  return { text: cleaned, format: options.format, chars: cleaned.length };
}

async function readElement(
  target: Page | Frame,
  selector: string,
): Promise<{ html: string; text: string }> {
  let handle;
  try {
    handle = await target.locator(selector).waitHandle();
  } catch {
    throw new BrowserPilotError(
      `No element matched selector ${selector}.`,
      'Run {action:"snapshot"} to find a stable ref, or check the selector.',
    );
  }
  try {
    return await handle.evaluate((element) => ({
      html: element.outerHTML,
      text: (element as HTMLElement).innerText ?? element.textContent ?? "",
    }));
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

async function outlineElement(target: Page | Frame, selector: string): Promise<string> {
  let handle;
  try {
    handle = await target.locator(selector).waitHandle();
  } catch {
    throw new BrowserPilotError(
      `No element matched selector ${selector}.`,
      'Run {action:"snapshot"} to find a stable ref, or check the selector.',
    );
  }
  try {
    return await handle.evaluate(buildOutline, 200);
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

/**
 * Runs in the page: a compact structural outline. Kept self-contained because
 * Puppeteer serializes the function into the page.
 */
function buildOutline(root: Element | null, limit: number): string {
  const scope = root ?? document.body;
  if (!scope) return "";
  const lines: string[] = [];
  const outlineTags = new Set([
    "main",
    "nav",
    "header",
    "footer",
    "aside",
    "section",
    "article",
    "form",
    "fieldset",
    "dialog",
    "table",
    "ul",
    "ol",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "a",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "details",
    "label",
    "img",
  ]);
  const textTags = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "a", "button", "summary", "label"]);
  const clean = (value: string, max = 80): string =>
    value.replace(/\s+/g, " ").trim().slice(0, max);

  const visible = (element: Element): boolean => {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const nameOf = (element: Element): string => {
    const aria = element.getAttribute("aria-label");
    if (aria) return clean(aria);
    const alt = element.getAttribute("alt");
    if (alt) return clean(alt);
    const title = element.getAttribute("title");
    if (title) return clean(title);
    if (textTags.has(element.tagName.toLowerCase())) {
      return clean((element as HTMLElement).innerText ?? element.textContent ?? "");
    }
    return "";
  };

  const describe = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const parts = [tag];
    const type = element.getAttribute("type");
    const role = element.getAttribute("role");
    const href = element.getAttribute("href");
    const placeholder = element.getAttribute("placeholder");
    const name = element.getAttribute("name");
    if (type) parts.push(`type=${type}`);
    if (role) parts.push(`role=${role}`);
    if (name) parts.push(`name=${name}`);
    if (placeholder) parts.push(`placeholder=${JSON.stringify(clean(placeholder))}`);
    if (href) parts.push(`-> ${clean(href, 120)}`);
    const text = nameOf(element);
    if (text) parts.push(JSON.stringify(text));
    return parts.join(" ");
  };

  const walk = (element: Element, depth: number): void => {
    if (lines.length >= limit) return;
    const tag = element.tagName.toLowerCase();
    if (["script", "style", "noscript", "template", "svg"].includes(tag)) return;
    if (!visible(element)) return;
    const role = element.getAttribute("role");
    const include = outlineTags.has(tag) || (role !== null && role !== "presentation");
    let childDepth = depth;
    if (include) {
      lines.push(`${"  ".repeat(depth)}${describe(element)}`);
      childDepth = depth + 1;
      if (lines.length >= limit) return;
    }
    for (const child of Array.from(element.children)) walk(child, childDepth);
    if (element.shadowRoot) {
      for (const child of Array.from(element.shadowRoot.children)) walk(child, childDepth);
    }
  };

  walk(scope, 0);
  if (lines.length >= limit) lines.push(`[Outline truncated at ${limit} lines.]`);
  return lines.join("\n");
}
