import { BrowserPilotError } from "./types";

export const ACTION_NAMES = [
  "help",
  "status",
  "open",
  "close",
  "navigate",
  "tabs",
  "snapshot",
  "read",
  "eval",
  "click",
  "type",
  "press",
  "select",
  "scroll",
  "hover",
  "wait",
  "screenshot",
  "console",
  "network",
  "dialog",
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];
export type ActionGroup =
  "lifecycle" | "tabs" | "navigation" | "inspect" | "interact" | "wait" | "state";

export interface ParamSpec {
  name: string;
  type: string;
  required?: boolean;
  description: string;
  default?: string;
  values?: string[];
}

export interface ActionSpec {
  name: ActionName;
  group: ActionGroup;
  summary: string;
  params: ParamSpec[];
  examples: string[];
  related?: string[];
}

export const GROUP_LABELS: Record<ActionGroup, string> = {
  lifecycle: "Lifecycle",
  tabs: "Tabs",
  navigation: "Navigation",
  inspect: "Inspect",
  interact: "Interact",
  wait: "Wait",
  state: "State",
};

const tab: ParamSpec = {
  name: "tab",
  type: "number",
  description: "Tab handle; defaults to the current tab.",
};

const ref: ParamSpec = {
  name: "ref",
  type: "string",
  description: "Element ref from snapshot, such as e12. Preferred over selector.",
};

const selector: ParamSpec = {
  name: "selector",
  type: "string",
  description: "CSS or Puppeteer selector; ignored when ref is set.",
};

const timeout: ParamSpec = {
  name: "timeout_ms",
  type: "number",
  description: "Action deadline in milliseconds.",
};

export const ACTIONS: Record<ActionName, ActionSpec> = {
  help: {
    name: "help",
    group: "lifecycle",
    summary: "List action groups, a group, or one action's parameters and examples.",
    params: [
      {
        name: "topic",
        type: "string",
        description:
          "An action name, or a group name (lifecycle, navigation, inspect, interact, state).",
      },
    ],
    examples: ['{action:"help"}', '{action:"help", topic:"click"}'],
  },
  status: {
    name: "status",
    group: "lifecycle",
    summary: "Show the browser, profile, port, tabs, current page, challenge, and pending dialog.",
    params: [],
    examples: ['{action:"status"}'],
    related: ["open", "help"],
  },
  open: {
    name: "open",
    group: "lifecycle",
    summary: "Ensure a browser and a tab exist; optionally navigate to a URL.",
    params: [
      {
        name: "url",
        type: "string",
        description: "Optional http(s) URL to open in the current or new tab.",
      },
      {
        name: "profile",
        type: "string",
        description:
          'Profile name or path for a new browser: "shared", "session", a name, or a path.',
      },
      tab,
      timeout,
    ],
    examples: ['{action:"open"}', '{action:"open", url:"https://example.com"}'],
    related: ["navigate", "status", "close"],
  },
  close: {
    name: "close",
    group: "lifecycle",
    summary: "Close the current tab, all agent tabs, or the browser.",
    params: [
      {
        name: "target",
        type: "string",
        required: true,
        values: ["tab", "tabs", "browser"],
        description: "What to close.",
      },
      tab,
    ],
    examples: ['{action:"close", target:"tab"}', '{action:"close", target:"browser"}'],
    related: ["tabs", "status"],
  },
  navigate: {
    name: "navigate",
    group: "navigation",
    summary: "Navigate the current tab, or go back, forward, or reload.",
    params: [
      {
        name: "url",
        type: "string",
        description: "Absolute http(s) URL.",
      },
      {
        name: "direction",
        type: "string",
        values: ["back", "forward", "reload"],
        description: "History action instead of a URL.",
      },
      {
        name: "wait_until",
        type: "string",
        values: ["load", "domcontentloaded", "networkidle0", "networkidle2"],
        default: "domcontentloaded",
        description: "Navigation lifecycle to wait for.",
      },
      tab,
      timeout,
    ],
    examples: [
      '{action:"navigate", url:"https://example.com"}',
      '{action:"navigate", direction:"back"}',
    ],
    related: ["snapshot", "read", "wait"],
  },
  tabs: {
    name: "tabs",
    group: "tabs",
    summary: "List, create, select, close, or clean up tabs.",
    params: [
      {
        name: "op",
        type: "string",
        required: true,
        values: ["list", "new", "select", "close", "close_others", "cleanup"],
        description: "Tab operation.",
      },
      tab,
      {
        name: "url",
        type: "string",
        description: "URL for op:new.",
      },
    ],
    examples: [
      '{action:"tabs", op:"list"}',
      '{action:"tabs", op:"new", url:"https://example.com"}',
      '{action:"tabs", op:"select", tab:2}',
    ],
    related: ["open", "close"],
  },
  snapshot: {
    name: "snapshot",
    group: "inspect",
    summary: "Return a compact accessibility-style tree with stable refs for interaction.",
    params: [
      {
        name: "interactive",
        type: "boolean",
        default: "true",
        description: "Only interactive elements, plus headings and landmarks when false.",
      },
      {
        name: "max_nodes",
        type: "number",
        description: "Maximum nodes to return.",
      },
      selector,
      tab,
    ],
    examples: ['{action:"snapshot"}', '{action:"snapshot", selector:"main"}'],
    related: ["click", "type", "read"],
  },
  read: {
    name: "read",
    group: "inspect",
    summary: "Read the page as markdown, text, or raw HTML.",
    params: [
      {
        name: "format",
        type: "string",
        values: ["markdown", "text", "html"],
        default: "markdown",
        description: "Output format.",
      },
      selector,
      {
        name: "max_chars",
        type: "number",
        description: "Per-call character cap.",
      },
      {
        name: "save_path",
        type: "string",
        description: "Write the full content to this file.",
      },
      tab,
    ],
    examples: ['{action:"read"}', '{action:"read", format:"text", selector:"main"}'],
    related: ["snapshot", "eval"],
  },
  eval: {
    name: "eval",
    group: "inspect",
    summary: "Evaluate JavaScript in the page and return a JSON-safe result.",
    params: [
      {
        name: "expression",
        type: "string",
        description: "Inline JavaScript. The last expression value is returned.",
      },
      {
        name: "script_path",
        type: "string",
        description: "Read the JavaScript from this file instead of expression.",
      },
      {
        name: "await_promise",
        type: "boolean",
        default: "true",
        description: "Await a returned promise.",
      },
      {
        name: "max_chars",
        type: "number",
        description: "Per-call character cap.",
      },
      {
        name: "save_path",
        type: "string",
        description: "Write the full result to this file.",
      },
      tab,
      timeout,
    ],
    examples: [
      '{action:"eval", expression:"document.title"}',
      '{action:"eval", script_path:"scripts/scrape.js"}',
    ],
    related: ["read", "console"],
  },
  click: {
    name: "click",
    group: "interact",
    summary: "Click an element by ref or selector.",
    params: [
      ref,
      selector,
      {
        name: "button",
        type: "string",
        values: ["left", "right", "middle"],
        default: "left",
        description: "Mouse button.",
      },
      {
        name: "click_count",
        type: "number",
        default: "1",
        description: "Number of clicks.",
      },
      {
        name: "modifiers",
        type: "string[]",
        values: ["Alt", "Control", "Meta", "Shift"],
        description: "Modifier keys held during the click.",
      },
      {
        name: "humanize",
        type: "boolean",
        description: "Move the mouse to the element before clicking.",
      },
      tab,
      timeout,
    ],
    examples: ['{action:"click", ref:"e12"}', '{action:"click", selector:"button.primary"}'],
    related: ["snapshot", "type", "wait"],
  },
  type: {
    name: "type",
    group: "interact",
    summary: "Fill or type text into an input, textarea, or contenteditable element.",
    params: [
      ref,
      selector,
      {
        name: "text",
        type: "string",
        description: "Inline text.",
      },
      {
        name: "text_file",
        type: "string",
        description: "Read the text from this file instead of text.",
      },
      {
        name: "text_env",
        type: "string",
        description: "Read the text from this environment variable instead of text.",
      },
      {
        name: "clear",
        type: "boolean",
        default: "true",
        description: "Clear the field before typing.",
      },
      {
        name: "submit",
        type: "boolean",
        default: "false",
        description: "Press Enter after typing.",
      },
      {
        name: "delay_ms",
        type: "number",
        default: "0",
        description: "Delay between keystrokes when typing with the keyboard.",
      },
      {
        name: "humanize",
        type: "boolean",
        description: "Use keyboard events and per-key delays.",
      },
      tab,
      timeout,
    ],
    examples: [
      '{action:"type", ref:"e3", text:"hello@example.com"}',
      '{action:"type", selector:"input[name=password]", text_env:"SITE_PASSWORD", submit:true}',
    ],
    related: ["snapshot", "click", "press"],
  },
  press: {
    name: "press",
    group: "interact",
    summary: "Press a key or key combination, optionally after focusing an element.",
    params: [
      {
        name: "key",
        type: "string",
        required: true,
        description: 'Key name, such as "Enter", "Escape", or "Control+A".',
      },
      ref,
      selector,
      tab,
      timeout,
    ],
    examples: ['{action:"press", key:"Enter"}', '{action:"press", key:"Escape"}'],
    related: ["type", "click"],
  },
  select: {
    name: "select",
    group: "interact",
    summary: "Select one or more options in a select element.",
    params: [
      ref,
      selector,
      {
        name: "values",
        type: "string[]",
        required: true,
        description: "Option values or labels to select.",
      },
      tab,
      timeout,
    ],
    examples: ['{action:"select", ref:"e7", values:["US"]}'],
    related: ["snapshot", "click"],
  },
  scroll: {
    name: "scroll",
    group: "interact",
    summary: "Scroll an element into view, or scroll the page up, down, to top, or to bottom.",
    params: [
      ref,
      selector,
      {
        name: "direction",
        type: "string",
        values: ["up", "down", "top", "bottom"],
        default: "down",
        description: "Scroll direction.",
      },
      {
        name: "amount",
        type: "number",
        default: "500",
        description: "Pixels for up/down.",
      },
      tab,
    ],
    examples: ['{action:"scroll", direction:"bottom"}', '{action:"scroll", ref:"e20"}'],
    related: ["snapshot", "wait"],
  },
  hover: {
    name: "hover",
    group: "interact",
    summary: "Move the mouse over an element.",
    params: [ref, selector, tab, timeout],
    examples: ['{action:"hover", ref:"e4"}'],
    related: ["click", "snapshot"],
  },
  wait: {
    name: "wait",
    group: "wait",
    summary: "Wait for a selector, text, URL, network idle, JavaScript condition, or human.",
    params: [
      {
        name: "for",
        type: "string",
        required: true,
        values: ["selector", "text", "url", "network_idle", "function", "human"],
        description: "What to wait for.",
      },
      selector,
      {
        name: "text",
        type: "string",
        description: "Text to wait for when for:text.",
      },
      {
        name: "url",
        type: "string",
        description: "URL substring to wait for when for:url.",
      },
      {
        name: "expression",
        type: "string",
        description: "Truthy JavaScript expression when for:function.",
      },
      tab,
      timeout,
    ],
    examples: [
      '{action:"wait", for:"selector", selector:"main"}',
      '{action:"wait", for:"human", timeout_ms:300000}',
    ],
    related: ["navigate", "read", "status"],
  },
  screenshot: {
    name: "screenshot",
    group: "inspect",
    summary: "Save a screenshot of the viewport, full page, or one element.",
    params: [
      {
        name: "path",
        type: "string",
        description: "Output path; defaults to the screenshots directory.",
      },
      {
        name: "full_page",
        type: "boolean",
        default: "false",
        description: "Capture the full scrollable page.",
      },
      selector,
      {
        name: "format",
        type: "string",
        values: ["png", "jpeg", "webp"],
        default: "png",
        description: "Image format.",
      },
      {
        name: "quality",
        type: "number",
        description: "JPEG/WebP quality from 0 to 100.",
      },
      {
        name: "inline",
        type: "boolean",
        default: "false",
        description: "Return the image to the model when it is small enough.",
      },
      tab,
    ],
    examples: ['{action:"screenshot"}', '{action:"screenshot", full_page:true}'],
    related: ["snapshot", "read"],
  },
  console: {
    name: "console",
    group: "inspect",
    summary: "Read or clear captured console messages and page errors.",
    params: [
      {
        name: "op",
        type: "string",
        required: true,
        values: ["read", "clear"],
        description: "Console operation.",
      },
      {
        name: "level",
        type: "string",
        values: ["log", "info", "warn", "error", "debug"],
        description: "Filter by level.",
      },
      {
        name: "limit",
        type: "number",
        description: "Maximum entries to return.",
      },
      tab,
    ],
    examples: ['{action:"console", op:"read"}', '{action:"console", op:"read", level:"error"}'],
    related: ["network", "eval"],
  },
  network: {
    name: "network",
    group: "inspect",
    summary: "Read or clear captured network requests and responses.",
    params: [
      {
        name: "op",
        type: "string",
        required: true,
        values: ["read", "clear"],
        description: "Network operation.",
      },
      {
        name: "filter",
        type: "string",
        description: "Only include URLs containing this substring.",
      },
      {
        name: "limit",
        type: "number",
        description: "Maximum entries to return.",
      },
      tab,
    ],
    examples: ['{action:"network", op:"read"}', '{action:"network", op:"read", filter:"/api/"}'],
    related: ["console", "wait"],
  },
  dialog: {
    name: "dialog",
    group: "state",
    summary: "Accept or dismiss a pending dialog, or change the automatic dialog policy.",
    params: [
      {
        name: "op",
        type: "string",
        required: true,
        values: ["accept", "dismiss", "policy"],
        description: "Dialog operation.",
      },
      {
        name: "text",
        type: "string",
        description: "Prompt response when op:accept.",
      },
      {
        name: "policy",
        type: "string",
        values: ["dismiss", "accept", "manual"],
        description: "Automatic policy when op:policy.",
      },
      tab,
    ],
    examples: ['{action:"dialog", op:"accept"}', '{action:"dialog", op:"policy", policy:"manual"}'],
    related: ["status"],
  },
};

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
  if (["click", "hover"].includes(action) && isMissing(params.ref) && isMissing(params.selector)) {
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
    const needs: Record<string, string> = {
      selector: "selector",
      text: "text",
      url: "url",
      function: "expression",
    };
    const required = needs[String(params.for)];
    if (required && isMissing(params[required])) {
      throw new BrowserPilotError(
        `wait for:${String(params.for)} requires ${required}.`,
        `Example: {action:"wait", for:"${String(params.for)}", ${required}:"..."}`,
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
  if (action === "dialog" && params.op === "policy" && isMissing(params.policy)) {
    throw new BrowserPilotError(
      "dialog op:policy requires policy dismiss/accept/manual.",
      'Example: {action:"dialog", op:"policy", policy:"manual"}',
    );
  }

  const closedSets: Array<[string, unknown, string[]]> = [
    ["read format", action === "read" ? params.format : undefined, ["markdown", "text", "html"]],
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
    [
      "console/network op",
      action === "console" || action === "network" ? params.op : undefined,
      ["read", "clear"],
    ],
    ["dialog op", action === "dialog" ? params.op : undefined, ["accept", "dismiss", "policy"]],
  ];
  for (const [label, value, allowed] of closedSets) {
    if (value !== undefined && !allowed.includes(String(value))) {
      throw new BrowserPilotError(`${label} must be one of: ${allowed.join(", ")}.`);
    }
  }

  const positive = ["tab", "max_nodes", "max_chars", "click_count", "limit", "timeout_ms"];
  for (const key of positive) {
    const value = params[key];
    if (typeof value === "number" && value <= 0) {
      throw new BrowserPilotError(`${key} must be greater than zero.`);
    }
  }
  for (const key of ["delay_ms", "amount"]) {
    const value = params[key];
    if (typeof value === "number" && value < 0) {
      throw new BrowserPilotError(`${key} must not be negative.`);
    }
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
    '  Clean up:           tabs {op:"list"} → tabs {op:"close", tab:N}',
    "",
    'Call {action:"help", topic:"<action>"} for one action, or',
    'topic:"<group>" for lifecycle, navigation, inspect, interact, or state.',
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
