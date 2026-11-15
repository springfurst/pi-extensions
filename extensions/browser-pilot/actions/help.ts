import { BrowserPilotError } from "../types";
import { ACTIONS, ACTION_NAMES, GROUPS } from "./registry";
import type { ActionGroup, ActionName } from "./spec-types";

/** Validate required parameters, unknown fields, and action-specific alternatives. */
export function validateAction(action: ActionName, params: Record<string, unknown>): void {
  const spec = ACTIONS[action];
  const allowed = new Set(spec.params.map((param) => param.name));
  for (const key of Object.keys(params)) {
    if (allowed.has(key)) continue;
    throw new BrowserPilotError(
      `Unknown ${action} parameter "${key}".`,
      `Valid params: ${spec.params.map((param) => param.name).join(", ") || "(none)"}\n${formatUsage(action)}`,
    );
  }

  if (action === "help") {
    validateHelpTarget(params);
    return;
  }

  for (const param of spec.params) {
    if (!param.required) continue;
    if (isMissing(params[param.name])) {
      throw new BrowserPilotError(
        `${action} requires ${param.name}.`,
        `${formatUsage(action)}\nExample: ${spec.examples[0]}`,
      );
    }
  }

  if (action === "navigate" && isMissing(params.url) && isMissing(params.direction)) {
    throw new BrowserPilotError(
      "navigate requires url, or direction back/forward/reload.",
      'Example: {action:"navigate",params:{url:"https://example.com"}}',
    );
  }
  if (
    action === "navigate" &&
    params.direction !== undefined &&
    !["back", "forward", "reload"].includes(String(params.direction))
  ) {
    throw new BrowserPilotError("navigate direction must be back, forward, or reload.");
  }
  if (
    action === "scroll" &&
    params.direction !== undefined &&
    !["up", "down", "top", "bottom"].includes(String(params.direction))
  ) {
    throw new BrowserPilotError("scroll direction must be up, down, top, or bottom.");
  }
  if (
    ["click", "hover", "highlight"].includes(action) &&
    isMissing(params.ref) &&
    isMissing(params.selector)
  ) {
    throw new BrowserPilotError(
      `${action} requires ref or selector.`,
      `Example: ${spec.examples[0]}\nTip: run {action:"snapshot"} to get refs.`,
    );
  }
  if (action === "type") {
    if (isMissing(params.ref) && isMissing(params.selector)) {
      throw new BrowserPilotError(
        "type requires ref or selector.",
        `Example: ${spec.examples[0]}\nTip: run {action:"snapshot"} to get refs.`,
      );
    }
    const sources = [params.text, params.text_file, params.text_env].filter(
      (value) => !isMissing(value),
    );
    if (sources.length !== 1) {
      throw new BrowserPilotError(
        "type requires exactly one of text, text_file, or text_env.",
        'Example: {action:"type",params:{ref:"e3",text:"hello"}}',
      );
    }
  }
  if (action === "select" && isMissing(params.ref) && isMissing(params.selector)) {
    throw new BrowserPilotError(
      "select requires ref or selector.",
      'Example: {action:"select",params:{ref:"e7",values:["US"]}}',
    );
  }
  if (action === "eval") {
    const sources = [params.expression, params.script_path].filter((value) => !isMissing(value));
    if (sources.length !== 1) {
      throw new BrowserPilotError(
        "eval requires exactly one of expression or script_path.",
        'Example: {action:"eval",params:{expression:"document.title"}}',
      );
    }
  }
  if (action === "wait") {
    const kind = String(params.until);
    if (kind === "selector" && isMissing(params.selector) && isMissing(params.ref)) {
      throw new BrowserPilotError(
        "wait until:selector requires selector or ref.",
        'Example: {action:"wait",params:{until:"selector",selector:"main"}}',
      );
    }
    const needs: Record<string, string> = {
      text: "text",
      url: "url",
      response: "url_pattern",
      function: "expression",
    };
    const required = needs[kind];
    if (required && isMissing(params[required])) {
      throw new BrowserPilotError(
        `wait until:${kind} requires ${required}.`,
        `Example: {action:"wait",params:{until:"${kind}",${required}:"..."}}`,
      );
    }
  }
  if (
    action === "tabs" &&
    ["select", "close"].includes(String(params.operation)) &&
    isMissing(params.tab)
  ) {
    throw new BrowserPilotError(
      `tabs operation:${String(params.operation)} requires tab.`,
      'Example: {action:"tabs",params:{operation:"close",tab:2}}',
    );
  }
  if (action === "frames" && params.operation === "select" && isMissing(params.frame)) {
    throw new BrowserPilotError(
      "frames operation:select requires frame.",
      'Run {action:"frames",params:{operation:"list"}} to see frame indices.',
    );
  }
  if (action === "clipboard" && params.operation === "write") {
    const sources = [params.text, params.text_file, params.text_env].filter(
      (value) => !isMissing(value),
    );
    if (sources.length !== 1) {
      throw new BrowserPilotError(
        "clipboard operation:write requires exactly one of text, text_file, or text_env.",
        'Example: {action:"clipboard",params:{operation:"write",text:"hello"}}',
      );
    }
  }
  if (action === "network" && params.operation === "get" && isMissing(params.request_id)) {
    throw new BrowserPilotError(
      "network operation:get requires request_id.",
      'Run {action:"network",params:{operation:"read"}} to see request ids such as r12.',
    );
  }
  if (action === "dialog" && params.operation === "policy" && isMissing(params.policy)) {
    throw new BrowserPilotError(
      "dialog operation:policy requires policy dismiss/accept/manual.",
      'Example: {action:"dialog",params:{operation:"policy",policy:"manual"}}',
    );
  }
  if (action === "connect" && isMissing(params.endpoint)) {
    throw new BrowserPilotError(
      "connect requires endpoint.",
      'Example: {action:"connect",params:{endpoint:"http://127.0.0.1:9222"}}',
    );
  }
  if (action === "upload") {
    if (isMissing(params.ref) && isMissing(params.selector)) {
      throw new BrowserPilotError(
        "upload requires ref or selector.",
        `Example: ${spec.examples[0]}\nTip: run {action:"snapshot"} to get refs.`,
      );
    }
    if (!Array.isArray(params.files) || params.files.length === 0) {
      throw new BrowserPilotError(
        "upload requires a non-empty files array.",
        'Example: {action:"upload",params:{ref:"e4",files:["./resume.pdf"]}}',
      );
    }
  }
  if (action === "cookies") {
    const op = String(params.operation);
    if (op === "set" && (isMissing(params.name) || isMissing(params.value))) {
      throw new BrowserPilotError(
        "cookies operation:set requires name and value.",
        'Example: {action:"cookies",params:{operation:"set",name:"theme",value:"dark",url:"https://example.com"}}',
      );
    }
    if ((op === "set" || op === "delete") && isMissing(params.url) && isMissing(params.domain)) {
      throw new BrowserPilotError(
        `cookies operation:${op} requires url or domain.`,
        'Example: {action:"cookies",params:{operation:"delete",name:"theme",domain:"example.com"}}',
      );
    }
    if (op === "delete" && isMissing(params.name)) {
      throw new BrowserPilotError(
        "cookies operation:delete requires name.",
        'Example: {action:"cookies",params:{operation:"delete",name:"theme",domain:"example.com"}}',
      );
    }
  }
  if (action === "storage") {
    const op = String(params.operation);
    if ((op === "get" || op === "remove") && isMissing(params.key)) {
      throw new BrowserPilotError(
        `storage operation:${op} requires key.`,
        'Example: {action:"storage",params:{operation:"get",key:"token"}}',
      );
    }
    if (op === "set" && (isMissing(params.key) || isMissing(params.value))) {
      throw new BrowserPilotError(
        "storage operation:set requires key and value.",
        'Example: {action:"storage",params:{operation:"set",key:"theme",value:"dark"}}',
      );
    }
  }
  if (action === "route") {
    const op = String(params.operation);
    if (op === "remove" && isMissing(params.rule_id)) {
      throw new BrowserPilotError(
        "route operation:remove requires rule_id.",
        'Example: {action:"route",params:{operation:"remove",rule_id:"rt1"}}',
      );
    }
    if (op === "add" && isMissing(params.route_action)) {
      throw new BrowserPilotError(
        "route operation:add requires route_action.",
        'Example: {action:"route",params:{operation:"add",url_pattern:"*://*/*.png",route_action:"abort"}}',
      );
    }
  }
  if (action === "expect") {
    if (isMissing(params.check)) {
      throw new BrowserPilotError(
        "expect requires check.",
        'Example: {action:"expect",params:{check:"text",expected:"Welcome"}}',
      );
    }
    if (
      !["selector", "visible", "hidden"].includes(String(params.check)) &&
      isMissing(params.expected)
    ) {
      throw new BrowserPilotError(
        `expect check:${String(params.check)} requires expected.`,
        'Example: {action:"expect",params:{check:"count",selector:".row",expected:"3"}}',
      );
    }
    const needsTarget = ["value", "attribute", "visible", "hidden", "count"];
    if (
      needsTarget.includes(String(params.check)) &&
      isMissing(params.ref) &&
      isMissing(params.selector)
    ) {
      throw new BrowserPilotError(
        `expect check:${String(params.check)} requires ref or selector.`,
        'Run {action:"snapshot"} to get refs.',
      );
    }
    if (params.check === "attribute" && isMissing(params.attribute)) {
      throw new BrowserPilotError(
        "expect check:attribute requires attribute.",
        'Example: {action:"expect",params:{check:"attribute",ref:"e4",attribute:"href",expected:"/docs"}}',
      );
    }
  }
  if (action === "steps") {
    if (!Array.isArray(params.steps) || params.steps.length === 0) {
      throw new BrowserPilotError(
        "steps requires a non-empty steps array.",
        'Example: {action:"steps",params:{steps:[{action:"navigate",params:{url:"https://example.com"}},{action:"snapshot"}]}}',
      );
    }
    for (const rawStep of params.steps) {
      if (typeof rawStep !== "object" || rawStep === null || Array.isArray(rawStep)) {
        throw new BrowserPilotError(
          "Each step must be an object with action and optional params.",
          'Example: {action:"steps",params:{steps:[{action:"snapshot"}]}}',
        );
      }
      const step = rawStep as Record<string, unknown>;
      const extra = Object.keys(step).filter((key) => key !== "action" && key !== "params");
      if (extra.length > 0) {
        throw new BrowserPilotError(
          `Each step must use {action, params?}; unexpected ${extra.map((key) => `"${key}"`).join(", ")}.`,
          'Example: {action:"steps",params:{steps:[{action:"navigate",params:{url:"https://example.com"}},{action:"snapshot"}]}}',
        );
      }
      const stepAction = step.action;
      if (typeof stepAction !== "string" || !ACTION_NAMES.includes(stepAction as ActionName)) {
        throw new BrowserPilotError(`Unknown step action "${String(stepAction)}".`);
      }
      if (stepAction === "steps") {
        throw new BrowserPilotError("Nested steps are not allowed.");
      }
      const stepParams = step.params;
      if (
        stepParams !== undefined &&
        (typeof stepParams !== "object" || stepParams === null || Array.isArray(stepParams))
      ) {
        throw new BrowserPilotError(`Step ${stepAction} params must be an object.`);
      }
      validateAction(stepAction as ActionName, (stepParams ?? {}) as Record<string, unknown>);
    }
  }

  const closedSets: Array<[string, unknown, string[]]> = [
    [
      "read format",
      action === "read" ? params.format : undefined,
      ["markdown", "text", "html", "outline"],
    ],
    [
      "screenshot format",
      action === "screenshot" ? params.format : undefined,
      ["png", "jpeg", "webp"],
    ],
    [
      "tabs operation",
      action === "tabs" ? params.operation : undefined,
      ["list", "new", "select", "close", "close_others", "cleanup"],
    ],
    [
      "console operation",
      action === "console" ? params.operation : undefined,
      ["read", "list", "clear"],
    ],
    [
      "network operation",
      action === "network" ? params.operation : undefined,
      ["read", "list", "get", "clear"],
    ],
    [
      "frames operation",
      action === "frames" ? params.operation : undefined,
      ["list", "select", "main"],
    ],
    ["state operation", action === "state" ? params.operation : undefined, ["export", "import"]],
    [
      "clipboard operation",
      action === "clipboard" ? params.operation : undefined,
      ["read", "write"],
    ],
    [
      "dialog operation",
      action === "dialog" ? params.operation : undefined,
      ["accept", "dismiss", "policy"],
    ],
    [
      "download operation",
      action === "download" ? params.operation : undefined,
      ["list", "wait", "clear"],
    ],
    [
      "cookies operation",
      action === "cookies" ? params.operation : undefined,
      ["list", "set", "delete", "clear"],
    ],
    [
      "storage operation",
      action === "storage" ? params.operation : undefined,
      ["get", "set", "remove", "clear", "keys"],
    ],
    ["har operation", action === "har" ? params.operation : undefined, ["start", "stop", "clear"]],
    ["trace operation", action === "trace" ? params.operation : undefined, ["start", "stop"]],
    [
      "route operation",
      action === "route" ? params.operation : undefined,
      ["add", "remove", "clear", "list"],
    ],
    [
      "route action",
      action === "route" ? params.route_action : undefined,
      ["abort", "continue", "fulfill", "delay"],
    ],
    [
      "wait until",
      action === "wait" ? params.until : undefined,
      ["selector", "text", "url", "network_idle", "response", "function", "human"],
    ],
    [
      "console level",
      action === "console" ? params.level : undefined,
      ["log", "info", "warn", "error", "debug"],
    ],
    ["click button", action === "click" ? params.button : undefined, ["left", "right", "middle"]],
    [
      "dialog policy",
      action === "dialog" ? params.policy : undefined,
      ["dismiss", "accept", "manual"],
    ],
    [
      "cookie same_site",
      action === "cookies" ? params.same_site : undefined,
      ["Strict", "Lax", "None"],
    ],
    ["close target", action === "close" ? params.target : undefined, ["tab", "tabs", "browser"]],
    [
      "expect check",
      action === "expect" ? params.check : undefined,
      ["text", "selector", "url", "title", "value", "attribute", "visible", "hidden", "count"],
    ],
    [
      "expect operator",
      action === "expect" ? params.operator : undefined,
      ["equals", "contains", "matches", "not_equals", "not_contains", "gt", "lt", "gte", "lte"],
    ],
    [
      "emulate network_profile",
      action === "emulate" ? params.network_profile : undefined,
      ["offline", "slow3g", "fast3g", "slow4g", "fast4g"],
    ],
    [
      "emulate color_scheme",
      action === "emulate" ? params.color_scheme : undefined,
      ["light", "dark", "no-preference"],
    ],
    [
      "emulate reduced_motion",
      action === "emulate" ? params.reduced_motion : undefined,
      ["reduce", "no-preference"],
    ],
    ["storage area", action === "storage" ? params.storage_area : undefined, ["local", "session"]],
  ];
  for (const [label, value, allowed] of closedSets) {
    if (value !== undefined && !allowed.includes(String(value))) {
      throw new BrowserPilotError(`${label} must be one of: ${allowed.join(", ")}.`);
    }
  }

  const positive = [
    "tab",
    "max_nodes",
    "max_chars",
    "click_count",
    "limit",
    "timeout_ms",
    "width",
    "height",
    "device_scale_factor",
    "cpu_throttle",
    "response_status",
  ];
  for (const key of positive) {
    const value = params[key];
    if (typeof value === "number" && value <= 0) {
      throw new BrowserPilotError(`${key} must be greater than zero.`);
    }
  }
  for (const key of [
    "delay_ms",
    "duration_ms",
    "pixels",
    "latency",
    "download_throughput",
    "upload_throughput",
    "expires",
  ]) {
    const value = params[key];
    if (typeof value === "number" && value < 0) {
      throw new BrowserPilotError(`${key} must not be negative.`);
    }
  }
  if (typeof params.scale === "number" && (params.scale < 0.1 || params.scale > 2)) {
    throw new BrowserPilotError("scale must be between 0.1 and 2.");
  }
  if (typeof params.quality === "number" && (params.quality < 0 || params.quality > 100)) {
    throw new BrowserPilotError("quality must be between 0 and 100.");
  }
}

function validateHelpTarget(params: Record<string, unknown>): void {
  const group = params.group;
  const action = params.action;
  if (group !== undefined && action !== undefined) {
    throw new BrowserPilotError(
      "help takes group or action, not both.",
      'Examples: {action:"help",params:{group:"inspect"}} or {action:"help",params:{action:"snapshot"}}',
    );
  }
  if (group !== undefined && !(String(group).toLowerCase() in GROUPS)) {
    throw new BrowserPilotError(
      `Unknown help group "${String(group)}".`,
      `Groups: ${Object.keys(GROUPS).join(", ")}`,
    );
  }
  if (action !== undefined && !ACTION_NAMES.includes(String(action).toLowerCase() as ActionName)) {
    throw new BrowserPilotError(
      `Unknown help action "${String(action)}".`,
      `Groups: ${Object.keys(GROUPS).join(", ")}\nCall {action:"help"} to start from the catalog.`,
    );
  }
}

/** Render help for the catalog, a group, or one action. */
export function renderHelp(target: { group?: string; action?: string } = {}): string {
  if (target.group && target.action) {
    throw new BrowserPilotError("help takes group or action, not both.");
  }
  if (target.action) {
    const action = target.action.toLowerCase() as ActionName;
    if (action in ACTIONS) return formatUsage(action);
    throw new BrowserPilotError(
      `Unknown help action "${target.action}".`,
      `Groups: ${Object.keys(GROUPS).join(", ")}\nCall {action:"help"} to start from the catalog.`,
    );
  }
  if (target.group) {
    const group = target.group.toLowerCase() as ActionGroup;
    if (group in GROUPS) return renderGroup(group);
    throw new BrowserPilotError(
      `Unknown help group "${target.group}".`,
      `Groups: ${Object.keys(GROUPS).join(", ")}`,
    );
  }
  return renderCatalog();
}

function renderCatalog(): string {
  const rows = (Object.keys(GROUPS) as ActionGroup[]).map((group) => {
    const spec = GROUPS[group];
    return [spec.label, spec.summary];
  });
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = [
    "browser-pilot topics",
    "",
    'Call shape: {action:"<action>", params:{...}}. Omit params when the action takes none.',
    "Discover the tool in three steps:",
    '  {action:"help"}                               list topic groups',
    '  {action:"help", params:{group:"inspect"}}     actions in a group',
    '  {action:"help", params:{action:"snapshot"}}   parameters and examples',
    "",
    `${"Group".padEnd(width)}  What it covers`,
    `${"-".repeat(width)}  ${"-".repeat(58)}`,
    ...rows.map(([label, summary]) => `${label.padEnd(width)}  ${summary}`),
    "",
    "Call help with a group or an action for the next level.",
    "",
    "Hints and suggested next steps in results are optional suggestions.",
  ];
  return lines.join("\n");
}

function renderGroup(group: ActionGroup): string {
  const spec = GROUPS[group];
  const actions = ACTION_NAMES.filter((name) => ACTIONS[name].group === group);
  const lines = [`${spec.label} — ${spec.summary}`, "", spec.description, "", "Actions:"];
  for (const name of actions) {
    lines.push(`  ${name.padEnd(12)} ${ACTIONS[name].summary}`);
  }
  if (spec.related && spec.related.length > 0) {
    lines.push("");
    lines.push(`Related groups: ${spec.related.map((name) => GROUPS[name].label).join(", ")}`);
  }
  lines.push("");
  lines.push(`Next: {action:"help", params:{action:"${actions[0]}"}} for parameters and examples.`);
  return lines.join("\n");
}

/** Full usage block for one action. */
export function formatUsage(action: ActionName): string {
  const spec = ACTIONS[action];
  const lines = [`${action} — ${spec.summary}`, "", `Use when: ${spec.when}`, "", "Params:"];
  if (spec.params.length === 0) {
    lines.push("  (none)");
  } else {
    const width = Math.max(...spec.params.map((param) => param.name.length));
    for (const param of spec.params) {
      const required = param.required ? " (required)" : "";
      const values = param.values ? ` values: ${param.values.join(" | ")}` : "";
      const def = param.default !== undefined ? ` default: ${param.default}` : "";
      lines.push(
        `  ${param.name.padEnd(width)}  ${param.type}${required}  ${param.description}${values}${def}`,
      );
    }
  }
  lines.push("");
  lines.push("Examples:");
  for (const example of spec.examples) {
    lines.push(`  ${example}`);
  }
  if (spec.related && spec.related.length > 0) {
    lines.push("");
    lines.push(`Related: ${spec.related.join(", ")}`);
  }
  return lines.join("\n");
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}
