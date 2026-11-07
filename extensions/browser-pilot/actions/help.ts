import { BrowserPilotError } from "../types";
import { ACTIONS, ACTION_NAMES, GROUP_LABELS } from "./registry";
import type { ActionGroup, ActionName } from "./spec-types";

/** Validate required parameters and action-specific alternatives. */
export function validateAction(action: ActionName, params: Record<string, unknown>): void {
  const spec = ACTIONS[action];
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
      'Example: {action:"navigate", url:"https://example.com"}',
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
        'Example: {action:"type", ref:"e3", text:"hello"}',
      );
    }
  }
  if (action === "select" && isMissing(params.ref) && isMissing(params.selector)) {
    throw new BrowserPilotError(
      "select requires ref or selector.",
      'Example: {action:"select", ref:"e7", values:["US"]}',
    );
  }
  if (action === "eval" && isMissing(params.expression) && isMissing(params.script_path)) {
    throw new BrowserPilotError(
      "eval requires expression or script_path.",
      'Example: {action:"eval", expression:"document.title"}',
    );
  }
  if (action === "wait") {
    const kind = String(params.for);
    if (kind === "selector" && isMissing(params.selector) && isMissing(params.ref)) {
      throw new BrowserPilotError(
        "wait for:selector requires selector or ref.",
        'Example: {action:"wait", for:"selector", selector:"main"}',
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
        `wait for:${kind} requires ${required}.`,
        `Example: {action:"wait", for:"${kind}", ${required}:"..."}`,
      );
    }
  }
  if (
    action === "tabs" &&
    ["select", "close"].includes(String(params.op)) &&
    isMissing(params.tab)
  ) {
    throw new BrowserPilotError(
      `tabs op:${String(params.op)} requires tab.`,
      'Example: {action:"tabs", op:"close", tab:2}',
    );
  }
  if (action === "frames" && params.op === "select" && isMissing(params.frame)) {
    throw new BrowserPilotError(
      "frames op:select requires frame.",
      'Run {action:"frames", op:"list"} to see frame indices.',
    );
  }
  if (action === "clipboard" && params.op === "write") {
    const sources = [params.text, params.text_file, params.text_env].filter(
      (value) => !isMissing(value),
    );
    if (sources.length !== 1) {
      throw new BrowserPilotError(
        "clipboard op:write requires exactly one of text, text_file, or text_env.",
        'Example: {action:"clipboard", op:"write", text:"hello"}',
      );
    }
  }
  if (action === "network" && params.op === "get" && isMissing(params.id)) {
    throw new BrowserPilotError(
      "network op:get requires id.",
      'Run {action:"network", op:"read"} to see request ids such as r12.',
    );
  }
  if (action === "dialog" && params.op === "policy" && isMissing(params.policy)) {
    throw new BrowserPilotError(
      "dialog op:policy requires policy dismiss/accept/manual.",
      'Example: {action:"dialog", op:"policy", policy:"manual"}',
    );
  }
  if (action === "connect" && isMissing(params.endpoint)) {
    throw new BrowserPilotError(
      "connect requires endpoint.",
      'Example: {action:"connect", endpoint:"http://127.0.0.1:9222"}',
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
        'Example: {action:"upload", ref:"e4", files:["./resume.pdf"]}',
      );
    }
  }
  if (action === "cookies") {
    const op = String(params.op);
    if (op === "set" && (isMissing(params.name) || isMissing(params.value))) {
      throw new BrowserPilotError(
        "cookies op:set requires name and value.",
        'Example: {action:"cookies", op:"set", name:"theme", value:"dark", url:"https://example.com"}',
      );
    }
    if ((op === "set" || op === "delete") && isMissing(params.url) && isMissing(params.domain)) {
      throw new BrowserPilotError(
        `cookies op:${op} requires url or domain.`,
        'Example: {action:"cookies", op:"delete", name:"theme", domain:"example.com"}',
      );
    }
    if (op === "delete" && isMissing(params.name)) {
      throw new BrowserPilotError(
        "cookies op:delete requires name.",
        'Example: {action:"cookies", op:"delete", name:"theme", domain:"example.com"}',
      );
    }
  }
  if (action === "storage") {
    const op = String(params.op);
    if ((op === "get" || op === "remove") && isMissing(params.key)) {
      throw new BrowserPilotError(
        `storage op:${op} requires key.`,
        'Example: {action:"storage", op:"get", key:"token"}',
      );
    }
    if (op === "set" && (isMissing(params.key) || isMissing(params.value))) {
      throw new BrowserPilotError(
        "storage op:set requires key and value.",
        'Example: {action:"storage", op:"set", key:"theme", value:"dark"}',
      );
    }
  }
  if (action === "route") {
    const op = String(params.op);
    if (op === "remove" && isMissing(params.id)) {
      throw new BrowserPilotError(
        "route op:remove requires id.",
        'Example: {action:"route", op:"remove", id:"r1"}',
      );
    }
    if (op === "add" && isMissing(params.route_action)) {
      throw new BrowserPilotError(
        "route op:add requires route_action.",
        'Example: {action:"route", op:"add", url_pattern:"*://*/*.png", route_action:"abort"}',
      );
    }
  }
  if (action === "expect") {
    if (isMissing(params.check)) {
      throw new BrowserPilotError(
        "expect requires check.",
        'Example: {action:"expect", check:"text", expected:"Welcome"}',
      );
    }
    if (
      !["selector", "visible", "hidden"].includes(String(params.check)) &&
      isMissing(params.expected)
    ) {
      throw new BrowserPilotError(
        `expect check:${String(params.check)} requires expected.`,
        'Example: {action:"expect", check:"count", selector:".row", expected:"3"}',
      );
    }
  }
  if (action === "steps") {
    if (!Array.isArray(params.steps) || params.steps.length === 0) {
      throw new BrowserPilotError(
        "steps requires a non-empty steps array.",
        'Example: {action:"steps", steps:[{action:"navigate", url:"https://example.com"},{action:"snapshot"}]}',
      );
    }
    if (params.steps.some((step) => step.action === "steps")) {
      throw new BrowserPilotError("Nested steps are not allowed.");
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
      "tabs op",
      action === "tabs" ? params.op : undefined,
      ["list", "new", "select", "close", "close_others", "cleanup"],
    ],
    ["console op", action === "console" ? params.op : undefined, ["read", "clear"]],
    ["network op", action === "network" ? params.op : undefined, ["read", "get", "clear"]],
    ["frames op", action === "frames" ? params.op : undefined, ["list", "select", "main"]],
    ["state op", action === "state" ? params.op : undefined, ["export", "import"]],
    ["clipboard op", action === "clipboard" ? params.op : undefined, ["read", "write"]],
    ["dialog op", action === "dialog" ? params.op : undefined, ["accept", "dismiss", "policy"]],
    ["download op", action === "download" ? params.op : undefined, ["list", "wait", "clear"]],
    [
      "cookies op",
      action === "cookies" ? params.op : undefined,
      ["list", "set", "delete", "clear"],
    ],
    [
      "storage op",
      action === "storage" ? params.op : undefined,
      ["get", "set", "remove", "clear", "keys"],
    ],
    ["har op", action === "har" ? params.op : undefined, ["start", "stop", "clear"]],
    ["trace op", action === "trace" ? params.op : undefined, ["start", "stop"]],
    ["route op", action === "route" ? params.op : undefined, ["add", "remove", "clear", "list"]],
    [
      "route action",
      action === "route" ? params.route_action : undefined,
      ["abort", "continue", "fulfill", "delay"],
    ],
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
    ["storage area", action === "storage" ? params.area : undefined, ["local", "session"]],
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
    "status",
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
    "amount",
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

/** Render help for the catalog, a group, or one action. */
export function renderHelp(topic?: string): string {
  if (!topic || topic === "all") return renderCatalog();
  const action = topic.toLowerCase() as ActionName;
  if (action in ACTIONS) {
    return formatUsage(action);
  }
  const group = topic.toLowerCase() as ActionGroup;
  if (group in GROUP_LABELS) {
    return renderGroup(group);
  }
  throw new BrowserPilotError(
    `Unknown help topic "${topic}".`,
    `Topics: ${[...Object.keys(GROUP_LABELS), ...ACTION_NAMES].join(", ")}`,
  );
}

function renderCatalog(): string {
  const rows: Array<[string, string]> = [];
  for (const group of Object.keys(GROUP_LABELS) as ActionGroup[]) {
    const actions = ACTION_NAMES.filter((name) => ACTIONS[name].group === group);
    rows.push([GROUP_LABELS[group], actions.map((name) => actionLabel(name)).join(", ")]);
  }
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = [
    "browser-pilot actions",
    "",
    "Each row is a group. The right column lists the actions in that group.",
    "",
    `${"Group".padEnd(width)}  Actions`,
    `${"-".repeat(width)}  ${"-".repeat(58)}`,
    ...rows.map(([label, actions]) => `${label.padEnd(width)}  ${actions}`),
    "",
    "Common workflows:",
    "  Read a page:        open → snapshot → read",
    "  Fill a form:        snapshot → type → click",
    "  Debug an SPA:       console → network",
    '  Handle a challenge: wait {for:"human"}',
    '  Record traffic:     har {op:"start"} → browse → har {op:"stop"}',
    "  Batch actions:      steps {steps:[...]}",
    '  Clean up:           tabs {op:"list"} → tabs {op:"close", tab:N}',
    "",
    'Call {action:"help", topic:"<action>"} for one action, or',
    'topic:"<group>" for lifecycle, navigation, inspect, interact, wait, state, or batch.',
    "",
    "Hints and suggested next steps in results are optional suggestions.",
  ];
  return lines.join("\n");
}

function renderGroup(group: ActionGroup): string {
  const actions = ACTION_NAMES.filter((name) => ACTIONS[name].group === group);
  const lines = [`${GROUP_LABELS[group]} actions`, ""];
  for (const name of actions) {
    lines.push(`  ${name.padEnd(12)} ${ACTIONS[name].summary}`);
  }
  lines.push("");
  lines.push(`Call {action:"help", topic:"<action>"} for parameters and examples.`);
  return lines.join("\n");
}

function actionLabel(name: ActionName): string {
  if (name === "tabs") return "tabs (op: list | new | select | close | close_others | cleanup)";
  if (name === "wait") {
    return "wait (for: selector | text | url | network_idle | function | human)";
  }
  if (name === "navigate") return "navigate (url, or direction: back | forward | reload)";
  if (name === "cookies") return "cookies (op: list | set | delete | clear)";
  if (name === "storage") return "storage (op: get | set | remove | clear | keys)";
  if (name === "download") return "download (op: list | wait | clear)";
  if (name === "har") return "har (op: start | stop | clear)";
  if (name === "trace") return "trace (op: start | stop)";
  if (name === "route") return "route (op: add | remove | clear | list)";
  return name;
}

/** Full usage block for one action. */
export function formatUsage(action: ActionName): string {
  const spec = ACTIONS[action];
  const lines = [`${action} — ${spec.summary}`, "", "Params:"];
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
  lines.push(`Example: ${spec.examples[0]}`);
  if (spec.related && spec.related.length > 0) {
    lines.push(`Related: ${spec.related.join(", ")}`);
  }
  return lines.join("\n");
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}
