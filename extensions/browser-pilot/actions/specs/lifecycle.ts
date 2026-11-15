import type { ActionSpec } from "../spec-types";
import { tab, timeout } from "../params";

export const lifecycleSpecs: Record<string, ActionSpec> = {
  help: {
    name: "help",
    group: "lifecycle",
    summary: "List topic groups, the actions in a group, or one action's parameters and examples.",
    when: "Use when you are unsure which action or parameter to use, or want to see related actions in a group.",
    params: [
      {
        name: "group",
        type: "string",
        description:
          "Topic group to describe: lifecycle, tabs, navigation, inspect, interact, wait, state, or batch.",
      },
      {
        name: "action",
        type: "string",
        description: "Action to describe, such as snapshot or click.",
      },
    ],
    examples: [
      '{action:"help"}',
      '{action:"help",params:{group:"inspect"}}',
      '{action:"help",params:{action:"snapshot"}}',
    ],
  },

  doctor: {
    name: "doctor",
    group: "lifecycle",
    summary:
      "Check the browser binary, profile, port, display, sandbox, directories, and stale state.",
    when: "Use when the browser will not launch or a profile, port, display, or directory looks wrong.",
    params: [],
    examples: ['{action:"doctor"}'],
    related: ["status", "open"],
  },

  status: {
    name: "status",
    group: "lifecycle",
    summary: "Show the browser, profile, port, tabs, current page, challenge, and pending dialog.",
    when: "Use to check whether a browser is running, which tabs are open, and whether a challenge or dialog is pending.",
    params: [],
    examples: ['{action:"status"}'],
    related: ["open", "help"],
  },

  open: {
    name: "open",
    group: "lifecycle",
    summary: "Ensure a browser and a tab exist; optionally navigate to a URL.",
    when: "Use to start a browser session or open a URL in the current or a new tab.",
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
    examples: ['{action:"open"}', '{action:"open",params:{url:"https://example.com"}}'],
    related: ["navigate", "status", "close"],
  },

  close: {
    name: "close",
    group: "lifecycle",
    summary: "Close the current tab, all agent tabs, or the browser.",
    when: "Use to release a tab, all agent tabs, or the browser when the work is done.",
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
    examples: [
      '{action:"close",params:{target:"tab"}}',
      '{action:"close",params:{target:"browser"}}',
    ],
    related: ["tabs", "status"],
  },

  connect: {
    name: "connect",
    group: "lifecycle",
    summary: "Attach to an existing Chrome DevTools endpoint instead of launching Chrome.",
    when: "Use when Chrome is already running with a DevTools endpoint and should not be launched.",
    params: [
      {
        name: "endpoint",
        type: "string",
        required: true,
        description: "WebSocket endpoint (ws://...) or DevTools HTTP endpoint (http://...).",
      },
    ],
    examples: ['{action:"connect",params:{endpoint:"http://127.0.0.1:9222"}}'],
    related: ["status", "close"],
  },
};
