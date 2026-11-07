import type { ParamSpec } from "./spec-types";

export const tab: ParamSpec = {
  name: "tab",
  type: "number",
  description: "Tab handle; defaults to the current tab.",
};

export const ref: ParamSpec = {
  name: "ref",
  type: "string",
  description: "Element ref from snapshot, such as e12. Preferred over selector.",
};

export const selector: ParamSpec = {
  name: "selector",
  type: "string",
  description: "CSS or Puppeteer selector; ignored when ref is set.",
};

export const timeout: ParamSpec = {
  name: "timeout_ms",
  type: "number",
  description: "Action deadline in milliseconds.",
};
