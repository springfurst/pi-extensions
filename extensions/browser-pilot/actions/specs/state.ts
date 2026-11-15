import type { ActionSpec } from "../spec-types";
import { tab, timeout } from "../params";

export const stateSpecs: Record<string, ActionSpec> = {
  dialog: {
    name: "dialog",
    group: "state",
    summary: "Accept or dismiss a pending dialog, or change the automatic dialog policy.",
    when: "Use to accept or dismiss a native dialog, or to switch to manual dialog handling.",
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
    ],
    examples: [
      '{action:"dialog",params:{op:"accept"}}',
      '{action:"dialog",params:{op:"policy",policy:"manual"}}',
    ],
    related: ["status"],
  },

  download: {
    name: "download",
    group: "state",
    summary: "List, wait for, or clear files downloaded by the browser.",
    when: "Use to list, wait for, or clear files downloaded by the browser.",
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
      '{action:"download",params:{op:"list"}}',
      '{action:"download",params:{op:"wait",timeout_ms:30000}}',
    ],
    related: ["click", "status"],
  },

  cookies: {
    name: "cookies",
    group: "state",
    summary: "List, set, delete, or clear browser cookies.",
    when: "Use to inspect or change cookies for the current browser.",
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
      '{action:"cookies",params:{op:"list"}}',
      '{action:"cookies",params:{op:"set",name:"theme",value:"dark",url:"https://example.com"}}',
    ],
    related: ["storage", "status"],
  },

  storage: {
    name: "storage",
    group: "state",
    summary: "Read or mutate localStorage and sessionStorage.",
    when: "Use to inspect or change localStorage or sessionStorage for the current tab.",
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
      '{action:"storage",params:{op:"get",key:"token"}}',
      '{action:"storage",params:{op:"set",key:"theme",value:"dark"}}',
    ],
    related: ["cookies", "eval"],
  },

  state: {
    name: "state",
    group: "state",
    summary: "Export or import cookies and per-origin storage as a versioned JSON bundle.",
    when: "Use to export or import cookies and per-origin storage for reuse in another session.",
    params: [
      {
        name: "op",
        type: "string",
        required: true,
        values: ["export", "import"],
        description: "Bundle operation.",
      },
      {
        name: "path",
        type: "string",
        required: true,
        description: "Bundle path; relative paths resolve against the working directory.",
      },
      tab,
    ],
    examples: [
      '{action:"state",params:{op:"export",path:"./auth.json"}}',
      '{action:"state",params:{op:"import",path:"./auth.json"}}',
    ],
    related: ["cookies", "storage", "open"],
  },

  clipboard: {
    name: "clipboard",
    group: "state",
    summary: "Read from or write to the system clipboard.",
    when: "Use to read or write the system clipboard from a secure page.",
    params: [
      {
        name: "op",
        type: "string",
        required: true,
        values: ["read", "write"],
        description: "Clipboard operation.",
      },
      {
        name: "text",
        type: "string",
        description: "Text to write.",
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
      tab,
    ],
    examples: [
      '{action:"clipboard",params:{op:"read"}}',
      '{action:"clipboard",params:{op:"write",text:"hello"}}',
    ],
    related: ["type", "eval"],
  },

  emulate: {
    name: "emulate",
    group: "state",
    summary: "Apply or reset viewport, media, network, CPU, locale, and geolocation emulation.",
    when: "Use to test a viewport, user agent, locale, timezone, network, CPU, geolocation, or permission state.",
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
        name: "permissions",
        type: "string[]",
        description:
          "Permissions to grant for the origin, such as geolocation, notifications, or clipboard-read.",
      },
      {
        name: "origin",
        type: "string",
        description: "Origin for permissions; defaults to the current page origin.",
      },
      {
        name: "reset",
        type: "boolean",
        description: "Reset all overrides to configuration defaults.",
      },
      tab,
    ],
    examples: [
      '{action:"emulate",params:{width:390,height:844,is_mobile:true,has_touch:true}}',
      '{action:"emulate",params:{reset:true}}',
    ],
    related: ["status", "screenshot"],
  },

  route: {
    name: "route",
    group: "state",
    summary: "Add, remove, list, or clear request interception rules.",
    when: "Use to intercept, block, delay, or fulfill requests for the pages this session manages.",
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
    ],
    examples: [
      '{action:"route",params:{op:"add",url_pattern:"*://*/*.png",route_action:"abort"}}',
      '{action:"route",params:{op:"list"}}',
    ],
    related: ["network", "wait"],
  },
};
