import type { ActionSpec } from "../spec-types";

export const batchSpecs: Record<string, ActionSpec> = {
  steps: {
    name: "steps",
    group: "batch",
    summary: "Run several actions in order and return each step's result.",
    when: "Use to run a short multi-step flow in one call and reduce round trips.",
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
      '{action:"steps",params:{steps:[{action:"navigate",params:{url:"https://example.com"}},{action:"snapshot"}]}}',
    ],
    related: ["help", "open"],
  },
};
