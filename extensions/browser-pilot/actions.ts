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
  "connect",
  "upload",
  "download",
  "cookies",
  "storage",
  "emulate",
  "pdf",
  "har",
  "trace",
  "route",
  "expect",
  "steps",
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];
export type ActionGroup =
  "lifecycle" | "tabs" | "navigation" | "inspect" | "interact" | "wait" | "state" | "batch";

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
  batch: "Batch",
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

  connect: {
    name: "connect",
    group: "lifecycle",
    summary: "Attach to an existing Chrome DevTools endpoint instead of launching Chrome.",
    params: [
      {
        name: "endpoint",
        type: "string",
        required: true,
        description: "WebSocket endpoint (ws://...) or DevTools HTTP endpoint (http://...).",
      },
    ],
    examples: ['{action:"connect", endpoint:"http://127.0.0.1:9222"}'],
    related: ["status", "close"],
  },
  upload: {
    name: "upload",
    group: "interact",
    summary: "Set the files of a file input element.",
    params: [
      ref,
      selector,
      {
        name: "files",
        type: "string[]",
        required: true,
        description: "Absolute or working-directory-relative file paths.",
      },
      tab,
      timeout,
    ],
    examples: ['{action:"upload", ref:"e4", files:["./resume.pdf"]}'],
    related: ["snapshot", "click"],
  },
  download: {
    name: "download",
    group: "state",
    summary: "List, wait for, or clear files downloaded by the browser.",
    params: [
      {
        name: "op",
        type: "string",
        required: true,
        values: ["list", "wait", "clear"],
        description: "Download operation.",
      },
      {
        name: "filter",
        type: "string",
        description: "Only match downloads whose filename or URL contains this text.",
      },
      timeout,
    ],
    examples: [
      '{action:"download", op:"list"}',
      '{action:"download", op:"wait", timeout_ms:30000}',
    ],
    related: ["click", "status"],
  },
  cookies: {
    name: "cookies",
    group: "state",
    summary: "List, set, delete, or clear browser cookies.",
    params: [
      {
        name: "op",
        type: "string",
        required: true,
        values: ["list", "set", "delete", "clear"],
        description: "Cookie operation.",
      },
      { name: "name", type: "string", description: "Cookie name." },
      { name: "value", type: "string", description: "Cookie value for op:set." },
      {
        name: "url",
        type: "string",
        description: "Cookie URL; use for list or as an alternative to domain.",
      },
      { name: "domain", type: "string", description: "Cookie domain." },
      { name: "cookie_path", type: "string", description: "Cookie path; defaults to /." },
      {
        name: "expires",
        type: "number",
        description: "Expiry as Unix seconds; omit for a session cookie.",
      },
      { name: "http_only", type: "boolean", description: "Mark the cookie HttpOnly." },
      { name: "secure", type: "boolean", description: "Mark the cookie Secure." },
      {
        name: "same_site",
        type: "string",
        values: ["Strict", "Lax", "None"],
        description: "Cookie SameSite policy.",
      },
      tab,
    ],
    examples: [
      '{action:"cookies", op:"list"}',
      '{action:"cookies", op:"set", name:"theme", value:"dark", url:"https://example.com"}',
    ],
    related: ["storage", "status"],
  },
  storage: {
    name: "storage",
    group: "state",
    summary: "Read or mutate localStorage and sessionStorage.",
    params: [
      {
        name: "op",
        type: "string",
        required: true,
        values: ["get", "set", "remove", "clear", "keys"],
        description: "Storage operation.",
      },
      {
        name: "area",
        type: "string",
        values: ["local", "session"],
        default: "local",
        description: "Storage area.",
      },
      { name: "key", type: "string", description: "Storage key." },
      { name: "value", type: "string", description: "Storage value for op:set." },
      tab,
    ],
    examples: [
      '{action:"storage", op:"get", key:"token"}',
      '{action:"storage", op:"set", key:"theme", value:"dark"}',
    ],
    related: ["cookies", "eval"],
  },
  emulate: {
    name: "emulate",
    group: "state",
    summary: "Apply or reset viewport, media, network, CPU, locale, and geolocation emulation.",
    params: [
      { name: "width", type: "number", description: "Viewport width." },
      { name: "height", type: "number", description: "Viewport height." },
      { name: "device_scale_factor", type: "number", description: "Device pixel ratio." },
      { name: "is_mobile", type: "boolean", description: "Mobile viewport flag." },
      { name: "has_touch", type: "boolean", description: "Touch support flag." },
      { name: "user_agent", type: "string", description: "User agent override." },
      { name: "locale", type: "string", description: "Locale override." },
      { name: "timezone", type: "string", description: "Timezone override." },
      {
        name: "color_scheme",
        type: "string",
        values: ["light", "dark", "no-preference"],
        description: "prefers-color-scheme override.",
      },
      {
        name: "reduced_motion",
        type: "string",
        values: ["reduce", "no-preference"],
        description: "prefers-reduced-motion override.",
      },
      {
        name: "network_profile",
        type: "string",
        values: ["offline", "slow3g", "fast3g", "slow4g", "fast4g"],
        description: "Predefined network condition.",
      },
      { name: "latency", type: "number", description: "Network latency in milliseconds." },
      { name: "download_throughput", type: "number", description: "Download bytes per second." },
      { name: "upload_throughput", type: "number", description: "Upload bytes per second." },
      { name: "cpu_throttle", type: "number", description: "CPU slowdown factor; 1 disables." },
      { name: "latitude", type: "number", description: "Geolocation latitude." },
      { name: "longitude", type: "number", description: "Geolocation longitude." },
      { name: "accuracy", type: "number", description: "Geolocation accuracy in metres." },
      {
        name: "reset",
        type: "boolean",
        description: "Reset all overrides to configuration defaults.",
      },
      tab,
    ],
    examples: [
      '{action:"emulate", width:390, height:844, is_mobile:true, has_touch:true}',
      '{action:"emulate", reset:true}',
    ],
    related: ["status", "screenshot"],
  },
  pdf: {
    name: "pdf",
    group: "inspect",
    summary: "Print the current page to a PDF file.",
    params: [
      {
        name: "path",
        type: "string",
        description: "Output path; defaults to the exports directory.",
      },
      { name: "paper_format", type: "string", description: "Paper format such as A4 or Letter." },
      { name: "landscape", type: "boolean", description: "Print in landscape orientation." },
      { name: "print_background", type: "boolean", description: "Print background graphics." },
      { name: "scale", type: "number", description: "Print scale from 0.1 to 2." },
      { name: "page_ranges", type: "string", description: "Page ranges such as 1-5,8." },
      { name: "margin", type: "string", description: "Uniform margin such as 10mm." },
      tab,
    ],
    examples: [
      '{action:"pdf"}',
      '{action:"pdf", path:"./page.pdf", paper_format:"A4", print_background:true}',
    ],
    related: ["screenshot", "read"],
  },
  har: {
    name: "har",
    group: "inspect",
    summary: "Record network activity and export a HAR 1.2 file.",
    params: [
      {
        name: "op",
        type: "string",
        required: true,
        values: ["start", "stop", "clear"],
        description: "HAR operation.",
      },
      { name: "path", type: "string", description: "Output path for op:stop." },
      tab,
    ],
    examples: ['{action:"har", op:"start"}', '{action:"har", op:"stop", path:"./network.har"}'],
    related: ["network", "trace"],
  },
  trace: {
    name: "trace",
    group: "inspect",
    summary: "Record a Chrome trace and write it as JSON.",
    params: [
      {
        name: "op",
        type: "string",
        required: true,
        values: ["start", "stop"],
        description: "Trace operation.",
      },
      { name: "path", type: "string", description: "Output path for op:stop." },
      tab,
    ],
    examples: ['{action:"trace", op:"start"}', '{action:"trace", op:"stop", path:"./trace.json"}'],
    related: ["har", "network"],
  },
  route: {
    name: "route",
    group: "state",
    summary: "Add, remove, list, or clear request interception rules.",
    params: [
      {
        name: "op",
        type: "string",
        required: true,
        values: ["add", "remove", "clear", "list"],
        description: "Route operation.",
      },
      { name: "id", type: "string", description: "Rule id for op:remove." },
      {
        name: "url_pattern",
        type: "string",
        default: "*",
        description: "URL glob such as *://example.com/api/*.",
      },
      { name: "resource_type", type: "string", description: "Only match this resource type." },
      {
        name: "route_action",
        type: "string",
        values: ["abort", "continue", "fulfill", "delay"],
        description: "Action for matching requests.",
      },
      { name: "status", type: "number", description: "Response status for fulfill." },
      { name: "body", type: "string", description: "Response body for fulfill." },
      {
        name: "content_type",
        type: "string",
        description: "Response content type for fulfill.",
      },
      { name: "headers", type: "object", description: "Response headers for fulfill." },
      { name: "delay_ms", type: "number", description: "Delay before continuing." },
      tab,
    ],
    examples: [
      '{action:"route", op:"add", url_pattern:"*://*/*.png", route_action:"abort"}',
      '{action:"route", op:"list"}',
    ],
    related: ["network", "wait"],
  },
  expect: {
    name: "expect",
    group: "wait",
    summary: "Assert page text, URL, title, values, attributes, visibility, or element counts.",
    params: [
      {
        name: "check",
        type: "string",
        required: true,
        values: [
          "text",
          "selector",
          "url",
          "title",
          "value",
          "attribute",
          "visible",
          "hidden",
          "count",
        ],
        description: "What to assert.",
      },
      {
        name: "operator",
        type: "string",
        values: [
          "equals",
          "contains",
          "matches",
          "not_equals",
          "not_contains",
          "gt",
          "lt",
          "gte",
          "lte",
        ],
        description: "Comparison operator; defaults to contains for text and equals for others.",
      },
      { name: "expected", type: "string", description: "Expected value or pattern." },
      ref,
      selector,
      { name: "attribute", type: "string", description: "Attribute name for check:attribute." },
      timeout,
      tab,
    ],
    examples: [
      '{action:"expect", check:"text", expected:"Welcome"}',
      '{action:"expect", check:"count", selector:".row", expected:"3"}',
    ],
    related: ["wait", "snapshot"],
  },
  steps: {
    name: "steps",
    group: "batch",
    summary: "Run several actions in order and return each step's result.",
    params: [
      {
        name: "steps",
        type: "array",
        required: true,
        description: "Array of action parameter objects. Nested steps are not allowed.",
      },
      {
        name: "stop_on_error",
        type: "boolean",
        default: "true",
        description: "Stop at the first failing step.",
      },
    ],
    examples: [
      '{action:"steps", steps:[{action:"navigate", url:"https://example.com"},{action:"snapshot"}]}',
    ],
    related: ["help", "open"],
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
