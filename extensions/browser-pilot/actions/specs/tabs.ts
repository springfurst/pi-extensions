import type { ActionSpec } from "../spec-types";
import { tab } from "../params";

export const tabsSpecs: Record<string, ActionSpec> = {
  tabs: {
    name: "tabs",
    group: "tabs",
    summary: "List, create, select, close, or clean up tabs.",
    when: "Use to list, create, select, close, or clean up pages.",
    params: [
      {
        name: "operation",
        type: "string",
        required: true,
        values: ["list", "new", "select", "close", "close_others", "cleanup"],
        description: "Tab operation.",
      },
      tab,
      {
        name: "url",
        type: "string",
        description: "URL for operation:new.",
      },
    ],
    examples: [
      '{action:"tabs",params:{operation:"list"}}',
      '{action:"tabs",params:{operation:"new",url:"https://example.com"}}',
      '{action:"tabs",params:{operation:"select",tab:2}}',
    ],
    related: ["open", "close"],
  },

  frames: {
    name: "frames",
    group: "tabs",
    summary: "List frames, select a frame for read/eval/screenshot, or return to the main frame.",
    when: "Use when content lives in an iframe and read, eval, or element screenshots need to target it.",
    params: [
      {
        name: "operation",
        type: "string",
        required: true,
        values: ["list", "select", "main"],
        description: "Frame operation.",
      },
      {
        name: "frame",
        type: "number",
        description: "Frame index for operation:select; 0 is the main frame.",
      },
      tab,
    ],
    examples: [
      '{action:"frames",params:{operation:"list"}}',
      '{action:"frames",params:{operation:"select",frame:1}}',
      '{action:"frames",params:{operation:"main"}}',
    ],
    related: ["snapshot", "read", "eval"],
  },
};
