import type { Page } from "puppeteer-core";
import { htmlToBasicMarkdown } from "../../lib/markdown";
import { readabilityToMarkdown, stripDataUriImages } from "../../lib/readability";
import { BrowserPilotError } from "./types";

export type ContentFormat = "markdown" | "text" | "html";

export interface ReadContentOptions {
  format: ContentFormat;
  selector?: string;
}

export interface ReadContentResult {
  text: string;
  format: ContentFormat;
  chars: number;
}

/** Read the live page as markdown, text, or HTML. */
export async function readPageContent(
  page: Page,
  options: ReadContentOptions,
): Promise<ReadContentResult> {
  let text: string;
  if (options.selector) {
    const html = await page
      .$eval(options.selector, (element) => element.outerHTML)
      .catch(() => undefined);
    if (html === undefined) {
      throw new BrowserPilotError(
        `No element matched selector ${options.selector}.`,
        'Run {action:"snapshot"} to find a stable ref, or check the selector.',
      );
    }
    if (options.format === "html") {
      text = html;
    } else if (options.format === "text") {
      text = await page.$eval(
        options.selector,
        (element) => (element as HTMLElement).innerText ?? element.textContent ?? "",
      );
    } else {
      text = readabilityToMarkdown(html) ?? htmlToBasicMarkdown(html);
    }
  } else if (options.format === "html") {
    text = await page.content();
  } else if (options.format === "text") {
    text = await page.evaluate(() => document.body?.innerText ?? "");
  } else {
    const html = await page.content();
    text = readabilityToMarkdown(html) ?? "";
    if (text.length < 100) text = htmlToBasicMarkdown(html);
    if (!text) text = await page.evaluate(() => document.body?.innerText ?? "");
  }

  const cleaned = stripDataUriImages(text).trim();
  return { text: cleaned, format: options.format, chars: cleaned.length };
}
