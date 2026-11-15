export const ACTION_NAMES = [
  "help",
  "status",
  "doctor",
  "open",
  "close",
  "navigate",
  "tabs",
  "frames",
  "snapshot",
  "read",
  "eval",
  "click",
  "type",
  "press",
  "select",
  "scroll",
  "hover",
  "highlight",
  "wait",
  "screenshot",
  "metrics",
  "console",
  "network",
  "dialog",
  "connect",
  "upload",
  "download",
  "cookies",
  "storage",
  "state",
  "clipboard",
  "emulate",
  "pdf",
  "har",
  "trace",
  "route",
  "expect",
  "steps",
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];
export type ActionGroup =
  "lifecycle" | "tabs" | "navigation" | "inspect" | "interact" | "wait" | "state" | "batch";

export interface ParamSpec {
  name: string;
  type: string;
  required?: boolean;
  description: string;
  default?: string;
  values?: string[];
}

export interface ActionSpec {
  name: ActionName;
  group: ActionGroup;
  summary: string;
  /** When to reach for this action, in one or two sentences. */
  when: string;
  params: ParamSpec[];
  examples: string[];
  related?: string[];
}

export interface GroupSpec {
  label: string;
  summary: string;
  description: string;
  related?: ActionGroup[];
}
