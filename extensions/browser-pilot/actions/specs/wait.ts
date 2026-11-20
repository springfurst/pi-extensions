import type { ActionSpec } from "../spec-types";
import { tab, ref, selector, timeout } from "../params";

export const waitSpecs: Record<string, ActionSpec> = {
  wait: {
    name: "wait",
    group: "wait",
    summary:
      "Wait for a selector, text, URL, network idle, a response, a JavaScript condition, or a human.",
    when: "Use to wait for a selector, text, URL, network response, JavaScript condition, or a human to clear a challenge.",
    params: [
      {
        name: "until",
        type: "string",
        required: true,
        values: ["selector", "text", "url", "network_idle", "response", "function", "human"],
        description: "What to wait for.",
      },
      ref,
      selector,
      {
        name: "text",
        type: "string",
        description: "Text to wait for when until:text.",
      },
      {
        name: "url",
        type: "string",
        description: "URL substring to wait for when until:url.",
      },
      {
        name: "url_pattern",
        type: "string",
        description: "URL glob or substring when until:response.",
      },
      {
        name: "include_body",
        type: "boolean",
        description: "Include a response body preview when until:response.",
      },
      {
        name: "expression",
        type: "string",
        description: "Truthy JavaScript expression when until:function.",
      },
      tab,
      timeout,
    ],
    examples: [
      '{action:"wait",params:{until:"selector",selector:"main"}}',
      '{action:"wait",params:{until:"response",url_pattern:"/api/items"}}',
      '{action:"wait",params:{until:"human",timeout_ms:300000}}',
    ],
    related: ["navigate", "read", "network", "status"],
  },

  expect: {
    name: "expect",
    group: "wait",
    summary: "Assert page text, URL, title, values, attributes, visibility, or element counts.",
    when: "Use to assert that the page reached the expected state, with polling until the timeout.",
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
      {
        name: "expected",
        type: "mixed",
        description: "Expected value or pattern; booleans are compared as strings.",
      },
      ref,
      selector,
      { name: "attribute", type: "string", description: "Attribute name for check:attribute." },
      timeout,
      tab,
    ],
    examples: [
      '{action:"expect",params:{check:"text",expected:"Welcome"}}',
      '{action:"expect",params:{check:"count",selector:".row",expected:"3"}}',
    ],
    related: ["wait", "snapshot"],
  },
};
