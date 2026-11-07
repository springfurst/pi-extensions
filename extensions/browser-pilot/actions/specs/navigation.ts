import type { ActionSpec } from "../spec-types";
import { tab, timeout } from "../params";

export const navigationSpecs: Record<string, ActionSpec> = {
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
};
