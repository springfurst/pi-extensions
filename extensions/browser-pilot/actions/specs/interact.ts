import type { ActionSpec } from "../spec-types";
import { tab, ref, selector, timeout } from "../params";

export const interactSpecs: Record<string, ActionSpec> = {
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

  highlight: {
    name: "highlight",
    group: "interact",
    summary: "Flash an element outline for human handoff.",
    params: [
      ref,
      selector,
      {
        name: "duration_ms",
        type: "number",
        default: "1200",
        description: "How long the outline stays visible.",
      },
      {
        name: "color",
        type: "string",
        default: "#ff5c5c",
        description: "CSS color for the outline.",
      },
      tab,
    ],
    examples: ['{action:"highlight", ref:"e5"}', '{action:"highlight", selector:"#submit"}'],
    related: ["snapshot", "screenshot"],
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
};
