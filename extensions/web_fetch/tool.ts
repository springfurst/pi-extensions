import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createBrowserRenderer, type BrowserRenderer } from "../../lib/browser";
import { loadConfig } from "../../lib/config";
import { createFetchContext } from "./context";
import {
  applyModelSafeLimit,
  applyRenderCap,
  buildHeader,
  truncationHint,
  type TruncationBinding,
} from "./output";
import { renderUrl } from "./pipeline";
import type { WebFetchDetails } from "./render";
import {
  applyLineSelector,
  formatSelector,
  parseReadUrlTarget,
  selectorWantsRaw,
} from "./selector";
import type { ExecFn, FetchImpl, ResolveHost } from "./types";

export interface WebFetchParams {
  url: string;
  raw?: boolean;
  max_chars?: number;
  save_path?: string;
}

export interface WebFetchToolContext {
  cwd: string;
  agentDir: string;
  trusted: boolean;
  signal?: AbortSignal;
  exec?: ExecFn;
  fetch?: FetchImpl;
  resolve?: ResolveHost;
  cacheDir?: string;
  /** Optional headless-browser renderer; when omitted one is built from config. */
  renderPage?: BrowserRenderer;
}

export interface WebFetchToolResult {
  content: [{ type: "text"; text: string }];
  details: WebFetchDetails;
}

/** Fetch, shape, select, and cap one URL. Shared by the tool entry and tests. */
export async function executeWebFetch(
  params: WebFetchParams,
  toolCtx: WebFetchToolContext,
): Promise<WebFetchToolResult> {
  const parsed = parseReadUrlTarget(params.url);
  if (!parsed) throw new Error(`Not a readable URL: ${params.url}`);

  const config = loadConfig(toolCtx.cwd, {
    agentDir: toolCtx.agentDir,
    projectTrusted: toolCtx.trusted,
  });
  const maxChars =
    typeof params.max_chars === "number" &&
    Number.isFinite(params.max_chars) &&
    params.max_chars > 0
      ? Math.floor(params.max_chars)
      : config.fetch.maxChars;
  const raw = params.raw === true || selectorWantsRaw(parsed.sel);

  const renderPage =
    toolCtx.renderPage ?? (await createBrowserRenderer({ config: config.browser }));
  const fetchContext = createFetchContext({
    config: config.fetch,
    signal: toolCtx.signal,
    fetch: toolCtx.fetch,
    resolve: toolCtx.resolve,
    cacheDir: toolCtx.cacheDir,
    exec: toolCtx.exec,
    renderPage,
  });
  const result = await renderUrl(parsed.path, { raw, maxChars, ctx: fetchContext });
  // Select and save against the full rendered body; the render cap applies only
  // to the text returned to the model, after selection and any save_path write.
  const body = applyLineSelector(result.content, parsed.sel);

  let savedPath: string | undefined;
  if (params.save_path) {
    const target = isAbsolute(params.save_path)
      ? params.save_path
      : join(toolCtx.cwd, params.save_path);
    try {
      writeFileSync(target, body, "utf-8");
      savedPath = target;
    } catch (error) {
      result.notes.push(
        `Failed to write save_path: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const capped = applyRenderCap(body, maxChars);
  const limited = applyModelSafeLimit(capped.text);
  let text = buildHeader(result) + limited.text;
  let truncationBinding: TruncationBinding | undefined;
  if (limited.truncated) truncationBinding = "model";
  else if (result.truncated) truncationBinding = "render";
  if (truncationBinding) text += truncationHint(truncationBinding, maxChars, limited, savedPath);
  else if (savedPath) text += `\n\n[Saved to ${savedPath}]`;

  const details: WebFetchDetails = {
    url: result.url,
    finalUrl: result.finalUrl,
    contentType: result.contentType,
    method: result.method,
    truncated: truncationBinding !== undefined,
    truncationBinding,
    notes: result.notes,
    savedPath,
    selector: formatSelector(parsed.sel),
  };

  return { content: [{ type: "text", text }], details };
}
