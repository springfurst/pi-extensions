import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

interface TurndownListParent {
  nodeName: string;
  getAttribute(name: string): string | null;
  children: ArrayLike<unknown>;
}

/**
 * Build a Turndown instance configured for GFM with the fixes this port relies
 * on: `~~strikethrough~~`, unescaped heading periods, and single-space list
 * markers.
 */
export function createTurndown(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.use(gfm);
  // GFM spec uses ~~ (double tilde), not ~ (single).
  turndown.addRule("strikethrough", {
    filter: (node) => ["DEL", "S", "STRIKE"].includes(node.nodeName),
    replacement(content) {
      return `~~${content}~~`;
    },
  });
  // Unescape the backslash turndown inserts before periods in headings ("1." -> "1\.").
  turndown.addRule("heading", {
    filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
    replacement(content, node) {
      const level = Number(node.nodeName.charAt(1));
      const prefix = "#".repeat(level);
      const cleaned = content.replace(/\\([.])/g, "$1").trim();
      return `\n\n${prefix} ${cleaned}\n\n`;
    },
  });
  // Single space after the marker (turndown hardcodes three).
  turndown.addRule("listItem", {
    filter: "li",
    replacement(content, node, options) {
      const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n  ");
      const parent = node.parentNode as unknown as TurndownListParent | null;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === "OL") {
        const start = parent.getAttribute("start");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${(start ? Number(start) : 1) + index}. `;
      }
      return prefix + body + (node.nextSibling ? "\n" : "");
    },
  });
  return turndown;
}

/** Module-level instance, built lazily on first use. */
let turndown: TurndownService | undefined;

function getTurndown(): TurndownService {
  turndown ??= createTurndown();
  return turndown;
}

/** Convert an HTML fragment to markdown, stripping script and style tags first. */
export function htmlToBasicMarkdown(html: string): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  return getTurndown().turndown(cleaned).trim();
}
