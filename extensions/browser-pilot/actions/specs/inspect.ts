import type { ActionSpec } from "../spec-types";
import { tab, ref, selector, timeout } from "../params";

export const inspectSpecs: Record<string, ActionSpec> = {
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
    summary: "Read the page as markdown, text, raw HTML, or a structural outline.",
    params: [
      {
        name: "format",
        type: "string",
        values: ["markdown", "text", "html", "outline"],
        default: "markdown",
        description: "Output format.",
      },
      ref,
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
      ref,
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
      {
        name: "annotate",
        type: "boolean",
        default: "false",
        description: "Draw ref boxes and labels before capture.",
      },
      tab,
    ],
    examples: [
      '{action:"screenshot"}',
      '{action:"screenshot", full_page:true}',
      '{action:"screenshot", annotate:true}',
    ],
    related: ["snapshot", "read"],
  },

  metrics: {
    name: "metrics",
    group: "inspect",
    summary: "Show JavaScript heap, DOM, navigation timing, and resource metrics.",
    params: [tab],
    examples: ['{action:"metrics"}'],
    related: ["trace", "network", "har"],
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
        values: ["read", "list", "clear"],
        description: "Console operation; list is an alias for read.",
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
      {
        name: "detail",
        type: "boolean",
        description: "Include stack traces for page errors.",
      },
      tab,
    ],
    examples: [
      '{action:"console", op:"read"}',
      '{action:"console", op:"read", level:"error", detail:true}',
    ],
    related: ["network", "eval"],
  },

  network: {
    name: "network",
    group: "inspect",
    summary:
      "Read a compact request overview, inspect one request by id, or clear captured activity.",
    params: [
      {
        name: "op",
        type: "string",
        required: true,
        values: ["read", "list", "get", "clear"],
        description: "Network operation; list is an alias for read.",
      },
      {
        name: "id",
        type: "string",
        description: "Request id from the overview, such as r12, for op:get.",
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
      {
        name: "include_body",
        type: "boolean",
        default: "true",
        description: "Include a response body preview for op:get.",
      },
      {
        name: "max_chars",
        type: "number",
        description: "Body preview cap for op:get.",
      },
      tab,
    ],
    examples: [
      '{action:"network", op:"read", filter:"/api/"}',
      '{action:"network", op:"get", id:"r12"}',
    ],
    related: ["console", "wait", "har"],
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
};
