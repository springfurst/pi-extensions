import type { ActionSpec } from "../spec-types";
import { tab } from "../params";

export const tabsSpecs: Record<string, ActionSpec> = {
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

  frames: {
    name: "frames",
    group: "tabs",
    summary: "List frames, select a frame for read/eval/screenshot, or return to the main frame.",
    params: [
      {
        name: "op",
        type: "string",
        required: true,
        values: ["list", "select", "main"],
        description: "Frame operation.",
      },
      {
        name: "frame",
        type: "number",
        description: "Frame index for op:select; 0 is the main frame.",
      },
      tab,
    ],
    examples: [
      '{action:"frames", op:"list"}',
      '{action:"frames", op:"select", frame:1}',
      '{action:"frames", op:"main"}',
    ],
    related: ["snapshot", "read", "eval"],
  },
};
