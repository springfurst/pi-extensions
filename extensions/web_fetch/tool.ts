import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { BrowserRenderer } from "../../lib/browser";
import { loadConfig } from "../../lib/config";
import { USAGE_SCHEMA_VERSION, createFileUsageLogger, type UsageLogger } from "../../lib/logging";
import { PI_VERSION, TOOL_VERSION } from "../../lib/version";
import { createFetchContext } from "./context";
import { buildFetchBody } from "./logging";
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
import type { ExecFn, FetchImpl, RenderResult, ResolveHost } from "./types";

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
  /** Usage logger override; production uses the file logger when logging is enabled. */
  logger?: UsageLogger;
  /** Session and call metadata recorded with each usage event. */
  toolCallId?: string;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  mode?: string;
}

export interface WebFetchToolResult {
  content: [{ type: "text"; text: string }];
  details: WebFetchDetails;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Fetch, shape, select, and cap one URL. Shared by the tool entry and tests. */
export async function executeWebFetch(
  params: WebFetchParams,
  toolCtx: WebFetchToolContext,
): Promise<WebFetchToolResult> {
  const startedAt = Date.now();
  const parsed = parseReadUrlTarget(params.url);
  if (!parsed) throw new Error(`Not a readable URL: ${params.url}`);

  const config = loadConfig(toolCtx.cwd, {
    agentDir: toolCtx.agentDir,
    projectTrusted: toolCtx.trusted,
  });
  const logger =
    toolCtx.logger ??
    (config.logging.enabled
      ? createFileUsageLogger({
          cwd: toolCtx.cwd,
          agentDir: toolCtx.agentDir,
          tool: "web_fetch",
          config: config.logging,
        })
      : undefined);
  const selector = formatSelector(parsed.sel);

  const logUsage = (input: {
    selector?: string;
    result?: RenderResult;
    charCount?: number;
    truncated: boolean;
    truncationBinding?: TruncationBinding;
    savedPath?: string;
    error?: unknown;
  }): void => {
    if (!logger) return;
    const failed = input.error !== undefined || input.result?.method === "failed";
    try {
      logger.log({
        schema: USAGE_SCHEMA_VERSION,
        timestamp: new Date().toISOString(),
        tool: "web_fetch",
        toolVersion: TOOL_VERSION,
        piVersion: PI_VERSION,
        sessionId: toolCtx.sessionId,
        sessionFile: toolCtx.sessionFile,
        sessionName: toolCtx.sessionName,
        toolCallId: toolCtx.toolCallId,
        cwd: toolCtx.cwd,
        mode: toolCtx.mode,
        durationMs: Date.now() - startedAt,
        outcome: failed ? "error" : "ok",
        error: input.error ? messageOf(input.error) : undefined,
        ...buildFetchBody(
          {
            params,
            selector: input.selector,
            result: input.result,
            charCount: input.charCount,
            truncated: input.truncated,
            truncationBinding: input.truncationBinding,
            savedPath: input.savedPath,
          },
          config.logging.includeArgs,
        ),
      });
    } catch {
      // Usage logging is best-effort and must never affect the tool result.
    }
  };

  const maxChars =
    typeof params.max_chars === "number" &&
    Number.isFinite(params.max_chars) &&
    params.max_chars > 0
      ? Math.floor(params.max_chars)
      : config.fetch.maxChars;
  const raw = params.raw === true || selectorWantsRaw(parsed.sel);

  try {
    const fetchContext = createFetchContext({
      config: config.fetch,
      signal: toolCtx.signal,
      fetch: toolCtx.fetch,
      resolve: toolCtx.resolve,
      cacheDir: toolCtx.cacheDir,
      exec: toolCtx.exec,
      renderPage: toolCtx.renderPage,
      browserConfig: config.browser,
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

    logUsage({
      selector,
      result,
      charCount: body.length,
      truncated: truncationBinding !== undefined,
      truncationBinding,
      savedPath,
    });

    return { content: [{ type: "text", text }], details };
  } catch (error) {
    logUsage({ selector, truncated: false, error });
    throw error;
  }
}
