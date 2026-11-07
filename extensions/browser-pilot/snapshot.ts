import type { Frame, Page } from "puppeteer-core";

export interface SnapshotOptions {
  interactive: boolean;
  maxNodes: number;
  selector?: string;
}

export interface SnapshotResult {
  lines: string[];
  count: number;
  truncated: boolean;
  matched: boolean;
  refs: Array<{ ref: string; frame?: Frame }>;
}

/** Take a compact, ref-annotated snapshot of the page, its frames, and shadow roots. */
export async function snapshotPage(page: Page, options: SnapshotOptions): Promise<SnapshotResult> {
  const lines: string[] = [];
  const refs: Array<{ ref: string; frame?: Frame }> = [];
  let count = 0;
  let truncated = false;
  let matched = options.selector === undefined;
  const mainFrame = page.mainFrame();

  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    let result: {
      lines: string[];
      count: number;
      truncated: boolean;
      matched: boolean;
      error?: string;
    };
    try {
      result = await frame.evaluate(collectSnapshot, {
        interactive: options.interactive,
        maxNodes: options.maxNodes - count,
        startIndex: count,
        selector: options.selector,
      });
    } catch {
      continue;
    }
    if (result.error) throw new Error(result.error);
    matched ||= result.matched;
    if (frame !== mainFrame && result.lines.length > 0) {
      lines.push(`Frame: ${frame.url()}`);
    }
    lines.push(...result.lines);
    for (let index = 0; index < result.count; index++) {
      const ref = `e${count + index + 1}`;
      refs.push({ ref, frame: frame === mainFrame ? undefined : frame });
    }
    count += result.count;
    truncated ||= result.truncated;
    if (count >= options.maxNodes) {
      truncated = true;
      break;
    }
  }

  return { lines, count, truncated, matched, refs };
}

/**
 * Runs inside the page. Assigns `data-pi-ref` attributes and returns one line
 * per visible, meaningful element. Kept self-contained because Puppeteer
 * serializes the function into the page.
 */
function collectSnapshot(options: SnapshotOptions & { startIndex?: number }): {
  lines: string[];
  count: number;
  truncated: boolean;
  matched: boolean;
  error?: string;
} {
  const lines: string[] = [];
  let count = 0;
  let truncated = false;
  const startIndex = options.startIndex ?? 0;

  const roleOf = (el: Element): string | undefined => {
    const explicit = el.getAttribute("role");
    if (explicit && explicit !== "presentation" && explicit !== "none") return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    if (tag === "form") return "form";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "aside") return "complementary";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      if (type === "button" || type === "submit" || type === "reset") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "file") return "file";
      if (type === "search") return "searchbox";
      if (type === "number") return "spinbutton";
      if (type === "color") return "colorwell";
      return "textbox";
    }
    if (el.getAttribute("contenteditable") === "true") return "textbox";
    return undefined;
  };

  const interactiveRoles = new Set([
    "link",
    "button",
    "checkbox",
    "radio",
    "textbox",
    "searchbox",
    "combobox",
    "listbox",
    "option",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "treeitem",
    "gridcell",
    "cell",
    "file",
    "colorwell",
  ]);

  const visible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    let ancestor: Node | null = el;
    while (ancestor) {
      if (ancestor instanceof Element && ancestor.getAttribute("aria-hidden") === "true") {
        return false;
      }
      ancestor = ancestor.parentNode ?? (ancestor instanceof ShadowRoot ? ancestor.host : null);
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const clean = (value: string, limit = 120): string =>
    value.replace(/\s+/g, " ").trim().slice(0, limit);

  const labelText = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string =>
    Array.from(el.labels ?? [])
      .map((label) => {
        const clone = label.cloneNode(true) as HTMLElement;
        for (const control of Array.from(
          clone.querySelectorAll("input, select, textarea, button"),
        )) {
          control.remove();
        }
        return clone.textContent ?? "";
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

  const nameOf = (el: Element): string => {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return clean(ariaLabel);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (text.trim()) return clean(text);
    }
    if (el instanceof HTMLInputElement) {
      const labels = labelText(el);
      if (labels) return clean(labels);
      if (el.placeholder) return clean(el.placeholder);
      if (el.type === "button" || el.type === "submit" || el.type === "reset") {
        if (el.value) return clean(el.value);
      }
    }
    if (el instanceof HTMLTextAreaElement) {
      const labels = labelText(el);
      if (labels) return clean(labels);
      if (el.placeholder) return clean(el.placeholder);
    }
    if (el instanceof HTMLSelectElement) {
      const labels = labelText(el);
      if (labels) return clean(labels);
    }
    const alt = el.getAttribute("alt");
    if (alt) return clean(alt);
    const title = el.getAttribute("title");
    if (title) return clean(title);
    const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
    return clean(text);
  };

  const attr = (el: Element, name: string): string | undefined => {
    const value = el.getAttribute(name);
    return value === null ? undefined : value;
  };

  const valueOf = (el: Element): string | undefined => {
    if (el instanceof HTMLInputElement) {
      if (el.type === "password") return el.value ? "••••" : undefined;
      if (el.type === "checkbox" || el.type === "radio") return undefined;
      return el.value ? clean(el.value) : undefined;
    }
    if (el instanceof HTMLTextAreaElement) return el.value ? clean(el.value) : undefined;
    if (el instanceof HTMLSelectElement) {
      const selected = Array.from(el.selectedOptions)
        .map((option) => option.textContent ?? "")
        .join(", ");
      return selected ? clean(selected) : undefined;
    }
    return undefined;
  };

  const states = (el: Element): string[] => {
    const out: string[] = [];
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") out.push(`checked=${el.checked}`);
      if (el.disabled) out.push("disabled");
      if (el.required) out.push("required");
      if (el.readOnly) out.push("readonly");
    }
    if (el instanceof HTMLButtonElement || el instanceof HTMLSelectElement) {
      if (el.disabled) out.push("disabled");
    }
    if (el instanceof HTMLTextAreaElement) {
      if (el.disabled) out.push("disabled");
      if (el.required) out.push("required");
      if (el.readOnly) out.push("readonly");
    }
    for (const name of [
      "aria-checked",
      "aria-expanded",
      "aria-selected",
      "aria-pressed",
      "aria-disabled",
    ]) {
      const value = attr(el, name);
      if (value !== null && value !== undefined) out.push(`${name.slice(5)}=${value}`);
    }
    return out;
  };

  const candidateSelector = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "[role]",
    "[contenteditable='true']",
    "[tabindex]",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "main",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "img[alt]",
  ].join(",");

  const deepElements = (root: ParentNode): Element[] => {
    const out: Element[] = [];
    const walk = (parent: ParentNode) => {
      for (const child of Array.from(parent.children ?? [])) {
        out.push(child);
        if (child.shadowRoot) walk(child.shadowRoot);
        walk(child);
      }
    };
    walk(root);
    return out;
  };

  const allElements = deepElements(document);
  for (const previous of allElements) {
    if (previous.hasAttribute("data-pi-ref")) previous.removeAttribute("data-pi-ref");
  }

  let candidates = allElements;
  let matched = true;
  if (options.selector) {
    let roots: Element[];
    try {
      roots = allElements.filter((element) => element.matches(options.selector!));
    } catch (error) {
      return {
        lines: [],
        count: 0,
        truncated: false,
        matched: false,
        error: `Invalid snapshot selector: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    matched = roots.length > 0;
    const seen = new Set<Element>();
    candidates = [];
    for (const root of roots) {
      if (!seen.has(root)) {
        seen.add(root);
        candidates.push(root);
      }
      const rootsToWalk = root.shadowRoot ? [root, root.shadowRoot] : [root];
      for (const scope of rootsToWalk) {
        for (const descendant of deepElements(scope)) {
          if (seen.has(descendant)) continue;
          seen.add(descendant);
          candidates.push(descendant);
        }
      }
    }
  }

  for (const el of candidates) {
    if (count >= options.maxNodes) {
      truncated = true;
      break;
    }
    if (!el.matches(candidateSelector)) continue;
    if (!visible(el)) continue;
    const role = roleOf(el);
    if (!role) continue;
    if (options.interactive && !interactiveRoles.has(role)) continue;
    if (!options.interactive && interactiveRoles.has(role) && !nameOf(el)) continue;

    const ref = `e${startIndex + count + 1}`;
    el.setAttribute("data-pi-ref", ref);
    count++;

    const parts = [`[${ref}] ${role}`];
    const name = nameOf(el);
    if (name) parts.push(JSON.stringify(name));

    const value = valueOf(el);
    if (value) parts.push(`value=${JSON.stringify(value)}`);
    const href = el instanceof HTMLAnchorElement ? el.getAttribute("href") : null;
    if (href) parts.push(`-> ${clean(href, 160)}`);
    if (role === "heading") {
      const level = Number(el.tagName.slice(1));
      if (Number.isFinite(level)) parts.push(`level=${level}`);
    }
    const state = states(el);
    if (state.length > 0) parts.push(...state);
    lines.push(parts.join(" "));
  }

  return { lines, count, truncated, matched };
}

/** Escape a ref for use in a CSS attribute selector. Refs are generated, not user text. */
export function refSelector(ref: string): string | undefined {
  return /^e\d+$/.test(ref) ? `pierce/[data-pi-ref="${ref}"]` : undefined;
}
