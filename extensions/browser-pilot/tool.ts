import { createHash } from "node:crypto";
import { USAGE_SCHEMA_VERSION, createFileUsageLogger, type UsageRecord } from "../../lib/logging";
import { PI_VERSION, TOOL_VERSION } from "../../lib/version";
import { ACTION_NAMES, renderHelp, validateAction, type ActionName } from "./actions";
import { flattenCall, stringParam } from "./call";
import { loadBrowserPilotConfig } from "./config";
import { shouldRunHeadless } from "./launcher";
import { capForModel, capText, finalize, hint, pageHeader } from "./output";
import { stripPageHeader } from "./tool-helpers";
import { networkResult } from "./network";
import { getBrowserPilotSession, type BrowserPilotSession } from "./session";
import { stateResult } from "./state";
import { doctorResult } from "./doctor";
import { metricsResult } from "./metrics";
import { framesResult } from "./frames";
import { highlightResult } from "./highlight";
import { clipboardResult } from "./clipboard";
import { closeResult, connectResult, openResult, statusResult } from "./handlers/lifecycle";
import { navigateResult, tabsResult } from "./handlers/navigation";
import {
  consoleResult,
  evalResult,
  harResult,
  pdfResult,
  readResult,
  screenshotResult,
  snapshotResult,
  traceResult,
} from "./handlers/inspect";
import {
  clickResult,
  hoverResult,
  pressResult,
  scrollResult,
  selectResult,
  typeResult,
  uploadResult,
} from "./handlers/interact";
import { expectResult, waitResult } from "./handlers/wait";
import {
  cookiesResult,
  dialogResult,
  downloadResult,
  emulateResult,
  routeResult,
  storageResult,
} from "./handlers/state";
import type {
  BrowserPilotCall,
  BrowserPilotConfig,
  BrowserPilotContext,
  BrowserPilotDetails,
  BrowserPilotParams,
  BrowserPilotToolResult,
} from "./types";
import { BrowserPilotError } from "./types";

export type { BrowserPilotToolResult } from "./types";

const TINY_ACTIONS = new Set<ActionName>([
  "help",
  "status",
  "doctor",
  "open",
  "close",
  "tabs",
  "frames",
  "click",
  "type",
  "press",
  "select",
  "scroll",
  "hover",
  "highlight",
  "navigate",
  "wait",
  "screenshot",
  "metrics",
  "dialog",
  "connect",
  "upload",
  "download",
  "cookies",
  "storage",
  "state",
  "clipboard",
  "emulate",
  "pdf",
  "har",
  "trace",
  "route",
  "expect",
  "steps",
]);

const MAX_STEP_CHARS = 4_000;

/** Actions whose output contains values that must never reach usage logs. */
const REDACTED_OUTPUT_ACTIONS = new Set<ActionName>(["clipboard", "cookies", "storage"]);

/** Actions whose output is page-derived and needs `includeSensitiveArgs`. */
const CONTENT_OUTPUT_ACTIONS = new Set<ActionName>([
  "console",
  "eval",
  "expect",
  "network",
  "read",
  "snapshot",
  "steps",
]);

/** Actions whose output is safe even when argument logging is disabled. */
const SAFE_OUTPUT_ACTIONS = new Set<ActionName>(["help", "metrics"]);

/** Run one browser-pilot action, including validation, logging, and output caps. */
export async function executeBrowserPilot(
  call: BrowserPilotCall,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const startedAt = Date.now();
  const rawParams = call.params ?? {};
  const params = flattenCall(call);
  const config = loadBrowserPilotConfig(ctx.cwd, {
    agentDir: ctx.agentDir,
    projectTrusted: ctx.trusted,
  });
  const sessionId = ctx.sessionId ?? `pid-${process.pid}`;
  const logger = config.logging.enabled
    ? createFileUsageLogger({
        cwd: ctx.cwd,
        agentDir: ctx.agentDir,
        tool: "browser-pilot",
        config: config.logging,
      })
    : undefined;
  let session: BrowserPilotSession | undefined;
  let details: BrowserPilotDetails = { action: call.action };
  let outputText = "";

  try {
    if (call.action === "help") {
      validateAction("help", rawParams);
      outputText = renderHelp({
        group: stringParam(rawParams, "group"),
        action: stringParam(rawParams, "action"),
      });
      details = { action: "help" };
      return finalize(outputText, details);
    }

    validateAction(call.action, rawParams);
    session = getBrowserPilotSession({
      sessionId,
      agentDir: ctx.agentDir,
      cwd: ctx.cwd,
      config,
    });

    if (params.action === "status") {
      const status = await statusResult(session, config);
      outputText = status.text;
      details = status.details;
      return finalize(outputText, details);
    }

    const result = await dispatch(params, session, config, ctx);
    outputText = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    details = result.details;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hintText =
      error instanceof BrowserPilotError
        ? error.hint
        : /timeout/i.test(message)
          ? "Increase timeout_ms, or inspect the page with status."
          : undefined;
    const current = session ? currentPageLine(session) : undefined;
    outputText = [message, hintText ? hint(hintText) : undefined, current]
      .filter((line): line is string => !!line)
      .join("\n\n");
    details = {
      ...details,
      ...(await pageDetails(session)),
      error: message,
    };
    return {
      content: [{ type: "text", text: capForModel(outputText).text }],
      details,
      isError: true,
    };
  } finally {
    session?.touch();
    if (logger) {
      try {
        logger.log(
          buildUsageRecord({
            params,
            config,
            session,
            details,
            outputText,
            durationMs: Date.now() - startedAt,
            error: details.error,
            cwd: ctx.cwd,
            sessionId,
            sessionFile: ctx.sessionFile,
            sessionName: ctx.sessionName,
            toolCallId: ctx.toolCallId,
            mode: ctx.mode,
          }),
        );
      } catch {
        // Logging is best-effort by contract.
      }
    }
  }
}

async function dispatch(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  if (session.pendingDialog && !["dialog", "status", "close", "help"].includes(params.action)) {
    throw new BrowserPilotError(
      `A ${session.pendingDialog.type} dialog is open: ${session.pendingDialog.message}`,
      'Resolve it with {action:"dialog", params:{operation:"accept"}} or {action:"dialog", params:{operation:"dismiss"}}.',
    );
  }
  switch (params.action) {
    case "doctor":
      return doctorResult(session, config);
    case "open":
      return openResult(params, session, config, ctx);
    case "close":
      return closeResult(params, session, config);
    case "navigate":
      return navigateResult(params, session, ctx);
    case "tabs":
      return tabsResult(params, session, config);
    case "frames":
      return framesResult(params, session);
    case "snapshot":
      return snapshotResult(params, session, config);
    case "read":
      return readResult(params, session, config, ctx);
    case "eval":
      return evalResult(params, session, config, ctx);
    case "click":
      return clickResult(params, session, config);
    case "type":
      return typeResult(params, session, config, ctx);
    case "press":
      return pressResult(params, session, config);
    case "select":
      return selectResult(params, session, config);
    case "scroll":
      return scrollResult(params, session);
    case "hover":
      return hoverResult(params, session, config);
    case "highlight":
      return highlightResult(params, session, config);
    case "wait":
      return waitResult(params, session, config, ctx);
    case "screenshot":
      return screenshotResult(params, session, config);
    case "metrics":
      return metricsResult(params, session);
    case "console":
      return consoleResult(params, session);
    case "network":
      return networkResult(params, session);
    case "dialog":
      return dialogResult(params, session);
    case "connect":
      return connectResult(params, session);
    case "upload":
      return uploadResult(params, session, config, ctx);
    case "download":
      return downloadResult(params, session, ctx);
    case "cookies":
      return cookiesResult(params, session);
    case "storage":
      return storageResult(params, session);
    case "state":
      return stateResult(params, session, ctx);
    case "clipboard":
      return clipboardResult(params, session, ctx);
    case "emulate":
      return emulateResult(params, session);
    case "pdf":
      return pdfResult(params, session, config, ctx);
    case "har":
      return harResult(params, session, config, ctx);
    case "trace":
      return traceResult(params, session, config, ctx);
    case "route":
      return routeResult(params, session, config);
    case "expect":
      return expectResult(params, session, config, ctx);
    case "steps":
      return stepsResult(params, session, config, ctx);
    case "help":
    case "status":
      throw new BrowserPilotError(`Action ${params.action} is handled before dispatch.`);
  }
}

async function stepsResult(
  params: BrowserPilotParams,
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
  ctx: BrowserPilotContext,
): Promise<BrowserPilotToolResult> {
  const steps = params.steps ?? [];
  const results: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  let failed = false;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] as BrowserPilotCall;
    const action = step.action;
    const label = `Step ${index + 1}: ${String(action)}`;
    if (!action || !ACTION_NAMES.includes(action)) {
      const error = `Unknown step action "${String(action)}".`;
      failed = true;
      results.push({ action, ok: false, error });
      lines.push(`${label}\n${error}`);
      if (params.stop_on_error !== false) break;
      continue;
    }
    try {
      const stepParams = step.params ?? {};
      validateAction(action, stepParams);
      let result: BrowserPilotToolResult;
      if (action === "help") {
        result = finalize(
          renderHelp({
            group: stringParam(stepParams, "group"),
            action: stringParam(stepParams, "action"),
          }),
          { action: "help" },
        );
      } else if (action === "status") {
        const status = await statusResult(session, config);
        result = finalize(status.text, status.details);
      } else {
        result = await dispatch(flattenCall(step), session, config, ctx);
      }
      const stepText = result.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const cleaned = stripPageHeader(stepText);
      const capped = capText(cleaned, MAX_STEP_CHARS);
      const text = capped.truncated
        ? `${capped.text}\n[Step output truncated at ${MAX_STEP_CHARS} characters.]`
        : capped.text;
      if (result.isError) failed = true;
      results.push({ action, ok: !result.isError, text, details: result.details });
      lines.push(`${label}\n${text}`);
      if (result.isError && params.stop_on_error !== false) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed = true;
      results.push({ action, ok: false, error: message });
      lines.push(`${label}\n${message}`);
      if (params.stop_on_error !== false) break;
    }
  }
  const tab = session.current !== undefined ? session.tabs.get(session.current) : undefined;
  const header =
    tab && !tab.page.isClosed()
      ? pageHeader(tab.handle, tab.page.url(), await tab.page.title().catch(() => ""))
      : undefined;
  const body = lines.join("\n\n");
  const result = finalize(header ? `${header}\n\n${body}` : body, {
    action: "steps",
    steps: results,
    failed,
    error: failed ? "One or more steps failed." : undefined,
  });
  if (failed) result.isError = true;
  return result;
}

function currentPageLine(session: BrowserPilotSession): string | undefined {
  if (session.current === undefined) return undefined;
  const tab = session.tabs.get(session.current);
  if (!tab || tab.page.isClosed()) return undefined;
  return `Current: Tab ${tab.handle} · ${tab.page.url()}`;
}

async function pageDetails(
  session: BrowserPilotSession | undefined,
): Promise<Partial<BrowserPilotDetails>> {
  if (!session || session.current === undefined) return {};
  const tab = session.tabs.get(session.current);
  if (!tab || tab.page.isClosed()) return { tab: session.current };
  return {
    tab: tab.handle,
    url: tab.page.url(),
    title: await tab.page.title().catch(() => ""),
  };
}

export interface UsageRecordOptions {
  params: BrowserPilotParams;
  config: BrowserPilotConfig;
  session?: BrowserPilotSession;
  details: BrowserPilotDetails;
  outputText: string;
  durationMs: number;
  error?: string;
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  toolCallId?: string;
  mode?: string;
}

export function buildUsageRecord(options: UsageRecordOptions): UsageRecord {
  const { params, config, session, details, outputText, durationMs, error } = options;
  const safe = safeParams(params, config);
  const output = summarizeOutput(params.action, outputText, config);
  return {
    schema: USAGE_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    tool: "browser-pilot",
    toolVersion: TOOL_VERSION,
    piVersion: PI_VERSION,
    sessionId: session?.sessionId ?? options.sessionId,
    sessionFile: options.sessionFile,
    sessionName: options.sessionName,
    toolCallId: options.toolCallId,
    cwd: session?.cwd ?? options.cwd,
    mode: options.mode,
    durationMs,
    outcome: error ? "error" : "ok",
    error,
    action: params.action,
    profile: session?.profile?.label,
    pid: session?.instance?.pid,
    port: session?.instance?.port,
    chromeVersion: session?.instance?.chromeVersion,
    headless: session ? shouldRunHeadless(config) : undefined,
    tabCount: session?.tabs.size,
    tab: details.tab,
    url: config.logging.includeArgs ? details.url : undefined,
    title: config.logging.includeArgs ? details.title : undefined,
    status: details.status,
    challenge: config.logging.includeArgs ? details.challenge : undefined,
    truncated: details.truncated,
    savedPath: config.logging.includeArgs ? details.savedPath : undefined,
    params: safe,
    output,
  };
}

export function safeParams(
  params: BrowserPilotParams,
  config: BrowserPilotConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const safeKeys = [
    "action",
    "group",
    "help_action",
    "operation",
    "target",
    "tab",
    "direction",
    "wait_until",
    "format",
    "interactive",
    "max_nodes",
    "max_chars",
    "await_promise",
    "frame",
    "annotate",
    "duration_ms",
    "permissions",
    "color",
    "button",
    "click_count",
    "modifiers",
    "humanize",
    "clear",
    "submit",
    "delay_ms",
    "key",
    "values",
    "pixels",
    "until",
    "full_page",
    "quality",
    "inline_image",
    "level",
    "limit",
    "stack_traces",
    "include_body",
    "policy",
    "timeout_ms",
    "storage_area",
    "domain",
    "cookie_path",
    "expires",
    "http_only",
    "secure",
    "same_site",
    "width",
    "height",
    "device_scale_factor",
    "is_mobile",
    "has_touch",
    "user_agent",
    "locale",
    "timezone",
    "color_scheme",
    "reduced_motion",
    "network_profile",
    "latency",
    "download_throughput",
    "upload_throughput",
    "cpu_throttle",
    "latitude",
    "longitude",
    "accuracy",
    "reset",
    "paper_format",
    "landscape",
    "print_background",
    "scale",
    "page_ranges",
    "margin",
    "resource_type",
    "route_action",
    "response_status",
    "response_content_type",
    "request_id",
    "rule_id",
    "name",
    "check",
    "operator",
    "attribute",
    "stop_on_error",
  ];
  for (const key of safeKeys) {
    const value = params[key as keyof BrowserPilotParams];
    if (value !== undefined) out[key] = value;
  }
  if (config.logging.includeArgs) {
    for (const key of [
      "url",
      "selector",
      "ref",
      "filter",
      "path",
      "save_path",
      "text_file",
      "script_path",
      "endpoint",
      "files",
      "response_headers",
      "url_pattern",
      "origin",
    ]) {
      const value = params[key as keyof BrowserPilotParams];
      if (value !== undefined) out[key] = value;
    }
  }
  if (params.text !== undefined) {
    if (config.logging.includeSensitiveArgs)
      out.text = params.text.slice(0, config.logging.maxOutputChars);
    else out.text = { length: params.text.length, sha256: sha256(params.text) };
  }
  if (params.text_env !== undefined) out.text_env = params.text_env;
  if (params.expression !== undefined) {
    if (config.logging.includeSensitiveArgs) {
      out.expression = params.expression.slice(0, config.logging.maxOutputChars);
    } else {
      out.expression = { length: params.expression.length, sha256: sha256(params.expression) };
    }
  }
  if (params.expected !== undefined) {
    if (config.logging.includeSensitiveArgs) {
      out.expected = params.expected.slice(0, config.logging.maxOutputChars);
    } else {
      out.expected = { length: params.expected.length, sha256: sha256(params.expected) };
    }
  }
  for (const key of ["value", "response_body"] as const) {
    const value = params[key];
    if (value === undefined) continue;
    if (config.logging.includeSensitiveArgs) {
      out[key] = value.slice(0, config.logging.maxOutputChars);
    } else {
      out[key] = { length: value.length, sha256: sha256(value) };
    }
  }
  if (params.steps !== undefined) {
    out.steps = params.steps.map((step) => safeParams(flattenCall(step), config));
  }
  return out;
}

export function summarizeOutput(
  action: ActionName,
  text: string,
  config: BrowserPilotConfig,
): Record<string, unknown> | undefined {
  if (config.logging.outputs === "none") return undefined;
  const cap = config.logging.maxOutputChars;
  const base = {
    chars: text.length,
    lines: text.split("\n").length,
  };
  if (REDACTED_OUTPUT_ACTIONS.has(action)) {
    return { ...base, redacted: "sensitive output" };
  }
  if (CONTENT_OUTPUT_ACTIONS.has(action) && !config.logging.includeSensitiveArgs) {
    return { ...base, redacted: "page content" };
  }
  if (!config.logging.includeArgs && !SAFE_OUTPUT_ACTIONS.has(action)) {
    return { ...base, redacted: "arguments" };
  }
  if (config.logging.outputs === "full") {
    return { ...base, text: text.slice(0, cap), truncated: text.length > cap };
  }
  if (config.logging.outputs === "snippet" || !TINY_ACTIONS.has(action)) {
    const half = Math.max(1, Math.floor(cap / 2));
    return {
      ...base,
      head: text.slice(0, half),
      tail: text.length > half ? text.slice(-half) : undefined,
      truncated: text.length > cap,
    };
  }
  return { ...base, text: text.slice(0, cap), truncated: text.length > cap };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
