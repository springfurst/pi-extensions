import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadConfig } from "../../lib/config";
import { createFetchContext } from "./context";
import { applyModelSafeLimit, buildHeader, truncationHint, type TruncationBinding } from "./output";
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

  const fetchContext = createFetchContext({
    config: config.fetch,
    signal: toolCtx.signal,
    fetch: toolCtx.fetch,
    resolve: toolCtx.resolve,
    exec: toolCtx.exec,
  });
  const result = await renderUrl(parsed.path, { raw, maxChars, ctx: fetchContext });
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

  const limited = applyModelSafeLimit(body);
  let text = buildHeader(result) + limited.text;
  let truncationBinding: TruncationBinding | undefined;
  if (result.truncated) truncationBinding = "render";
  else if (limited.truncated) truncationBinding = "model";
  if (truncationBinding) text += truncationHint(truncationBinding, maxChars, limited, savedPath);

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
