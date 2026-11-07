import type { Page } from "puppeteer-core";
import { BrowserPilotError } from "./types";

export interface EvalOptions {
  source: string;
  awaitPromise: boolean;
  timeoutMs: number;
}

export interface EvalResult {
  value: unknown;
  type: string;
  description?: string;
}

/** Evaluate arbitrary JavaScript in the page's main world. */
export async function evaluateInPage(page: Page, options: EvalOptions): Promise<EvalResult> {
  const client = await page.createCDPSession();
  try {
    const response = await client.send("Runtime.evaluate", {
      expression: options.source,
      awaitPromise: options.awaitPromise,
      returnByValue: false,
      userGesture: true,
      timeout: options.timeoutMs,
      includeCommandLineAPI: false,
      silent: false,
    });
    if (response.exceptionDetails) {
      throw new BrowserPilotError(
        formatException(response.exceptionDetails),
        'The expression threw. Use console {op:"read"} to inspect page errors.',
      );
    }
    const remote = response.result;
    if (remote.objectId) {
      const serialized = await client.send("Runtime.callFunctionOn", {
        objectId: remote.objectId,
        functionDeclaration: SERIALIZER_SOURCE,
        returnByValue: true,
        awaitPromise: false,
      });
      if (serialized.exceptionDetails) {
        throw new BrowserPilotError(formatException(serialized.exceptionDetails));
      }
      const json = serialized.result.value;
      if (typeof json === "string") {
        try {
          return { value: JSON.parse(json), type: remote.type, description: remote.description };
        } catch {
          return { value: json, type: remote.type, description: remote.description };
        }
      }
      return { value: json, type: remote.type, description: remote.description };
    }
    return { value: remote.value, type: remote.type, description: remote.description };
  } finally {
    await client.detach().catch(() => undefined);
  }
}

/** Render an evaluation result as compact text. */
export function formatEvalValue(result: EvalResult): string {
  if (typeof result.value === "string") return result.value;
  if (result.value === undefined) return "undefined";
  try {
    return JSON.stringify(result.value, null, 2) ?? String(result.value);
  } catch {
    return String(result.value);
  }
}

function formatException(details: {
  text?: string;
  exception?: { description?: string; value?: unknown };
  lineNumber?: number;
  columnNumber?: number;
}): string {
  const description =
    details.exception?.description ??
    (typeof details.exception?.value === "string" ? details.exception.value : undefined) ??
    details.text ??
    "Evaluation failed";
  const location =
    details.lineNumber !== undefined
      ? ` (line ${details.lineNumber + 1}, column ${(details.columnNumber ?? 0) + 1})`
      : "";
  return `Evaluation failed${location}: ${description}`;
}

/**
 * Runs in the page to turn a remote object into JSON-safe data. Handles DOM
 * nodes, cycles, functions, bigints, maps, and depth/size limits.
 */
const SERIALIZER_SOURCE = `function () {
  const seen = new WeakSet();
  const maxDepth = 4;
  const maxItems = 100;
  function summarize(value, depth) {
    if (value === null) return null;
    const type = typeof value;
    if (type === "undefined") return { __type: "undefined" };
    if (type === "string" || type === "number" || type === "boolean") return value;
    if (type === "bigint") return { __type: "bigint", value: value.toString() };
    if (type === "symbol") return { __type: "symbol", value: value.toString() };
    if (type === "function") return { __type: "function", name: value.name || "anonymous" };
    if (value instanceof Node) {
      if (value.nodeType === 1) {
        const el = value;
        return {
          __type: "element",
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          class: typeof el.className === "string" ? el.className : undefined,
          text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 300)
        };
      }
      return { __type: "node", nodeType: value.nodeType, text: (value.textContent || "").slice(0, 300) };
    }
    if (value instanceof Window) return { __type: "window" };
    if (value instanceof Date) return { __type: "date", value: value.toISOString() };
    if (value instanceof RegExp) return { __type: "regexp", value: value.toString() };
    if (value instanceof Error) {
      return {
        __type: "error",
        name: value.name,
        message: value.message,
        stack: String(value.stack || "").slice(0, 1000)
      };
    }
    if (value instanceof Map) {
      if (seen.has(value)) return { __type: "circular" };
      seen.add(value);
      return {
        __type: "map",
        entries: Array.from(value.entries()).slice(0, maxItems).map(function (entry) {
          return [summarize(entry[0], depth + 1), summarize(entry[1], depth + 1)];
        })
      };
    }
    if (value instanceof Set) {
      if (seen.has(value)) return { __type: "circular" };
      seen.add(value);
      return {
        __type: "set",
        values: Array.from(value.values()).slice(0, maxItems).map(function (item) {
          return summarize(item, depth + 1);
        })
      };
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) return { __type: "circular" };
      seen.add(value);
      const out = value.slice(0, maxItems).map(function (item) {
        return summarize(item, depth + 1);
      });
      if (value.length > maxItems) out.push({ __type: "truncated", remaining: value.length - maxItems });
      return out;
    }
    if (type === "object") {
      if (seen.has(value)) return { __type: "circular" };
      seen.add(value);
      if (depth >= maxDepth) return { __type: "object", note: "max depth" };
      const out = {};
      const keys = Object.keys(value);
      for (const key of keys.slice(0, maxItems)) {
        try {
          out[key] = summarize(value[key], depth + 1);
        } catch (error) {
          out[key] = { __type: "unserializable", message: String(error) };
        }
      }
      if (keys.length > maxItems) out.__truncated = keys.length - maxItems;
      return out;
    }
    return String(value);
  }
  try {
    return JSON.stringify(summarize(this, 0));
  } catch (error) {
    return JSON.stringify({ __type: "unserializable", message: String(error) });
  }
}`;
