import type { ActionSpec } from "../spec-types";
import { tab, timeout } from "../params";

export const lifecycleSpecs: Record<string, ActionSpec> = {
  help: {
    name: "help",
    group: "lifecycle",
    summary: "List action groups, a group, or one action's parameters and examples.",
    params: [
      {
        name: "topic",
        type: "string",
        description:
          "An action name, or a group name (lifecycle, tabs, navigation, inspect, interact, wait, state, batch).",
      },
    ],
    examples: ['{action:"help"}', '{action:"help", topic:"click"}'],
  },

  doctor: {
    name: "doctor",
    group: "lifecycle",
    summary:
      "Check the browser binary, profile, port, display, sandbox, directories, and stale state.",
    params: [],
    examples: ['{action:"doctor"}'],
    related: ["status", "open"],
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
        description:
          "Optional http(s) URL to open in the current or new tab. A local path or file: URL is accepted when allowLocalFiles and localFileGlobs permit it.",
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
};
