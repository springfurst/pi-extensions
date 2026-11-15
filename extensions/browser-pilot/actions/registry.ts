import type { ActionGroup, ActionName, ActionSpec, GroupSpec } from "./spec-types";
import { ACTION_NAMES } from "./spec-types";
import { lifecycleSpecs } from "./specs/lifecycle";
import { tabsSpecs } from "./specs/tabs";
import { navigationSpecs } from "./specs/navigation";
import { inspectSpecs } from "./specs/inspect";
import { interactSpecs } from "./specs/interact";
import { waitSpecs } from "./specs/wait";
import { stateSpecs } from "./specs/state";
import { batchSpecs } from "./specs/batch";

export { ACTION_NAMES };
export type { ActionGroup, ActionName, ActionSpec, GroupSpec, ParamSpec } from "./spec-types";

export const GROUPS: Record<ActionGroup, GroupSpec> = {
  lifecycle: {
    label: "Lifecycle",
    summary: "Start here: open/status/close/connect and browser diagnostics.",
    description:
      "Start here when you need a browser or need to know what is open. open launches or reuses Chrome; status shows tabs, URL, challenge, and dialog; close shuts a tab or browser; connect attaches to an existing Chrome; doctor diagnoses launch problems.",
    related: ["navigation", "tabs"],
  },
  navigation: {
    label: "Navigation",
    summary: "Move the current tab and wait for the page to settle.",
    description:
      "Move the current tab and wait for the page to settle. navigate accepts a URL or back/forward/reload; wait_until controls the load state. Inspect or read the page after navigation.",
    related: ["inspect", "wait"],
  },
  tabs: {
    label: "Tabs",
    summary: "Multiple pages and frames.",
    description:
      "Work with multiple pages and frames. tabs lists, creates, selects, closes, and cleans up tabs; frames lists, selects, and resets the frame used by read, eval, and element screenshots.",
    related: ["navigation", "inspect"],
  },
  inspect: {
    label: "Inspect",
    summary: "Understand the page: snapshot, read, eval, console, network, exports.",
    description:
      "Understand the page before acting. snapshot returns stable refs; read returns content; eval answers computed questions; console and network diagnose behavior; screenshot, pdf, har, and trace export; metrics summarizes performance.",
    related: ["interact", "wait"],
  },
  interact: {
    label: "Interact",
    summary: "Act on elements: click, type, press, select, scroll, hover, upload.",
    description:
      "Act on elements. Run snapshot first, then click, type, press, select, scroll, hover, highlight, or upload using refs. Refs expire after navigation or a new snapshot.",
    related: ["inspect", "wait"],
  },
  wait: {
    label: "Wait",
    summary: "Synchronize and assert: selectors, text, URL, network, human.",
    description:
      "Synchronize with the page and assert outcomes. wait handles selectors, text, URLs, network idle, responses, JavaScript conditions, and human challenge handoff; expect polls assertions until they pass or the timeout expires.",
    related: ["interact", "inspect"],
  },
  state: {
    label: "State",
    summary: "Cookies, storage, emulation, routing, dialogs, downloads, clipboard.",
    description:
      "Manage browser state. cookies, storage, and state export/import handle sessions; emulate changes viewport, media, network, CPU, locale, and geolocation; route intercepts requests; dialog and download handle prompts and files; clipboard reads or writes the system clipboard.",
    related: ["inspect", "navigation"],
  },
  batch: {
    label: "Batch",
    summary: "Run several actions in one call.",
    description:
      "Run several actions in one call. steps reduces round trips for multi-step flows and can continue after a failure with stop_on_error:false. Nested steps are not allowed.",
  },
};

export const GROUP_LABELS = Object.fromEntries(
  Object.entries(GROUPS).map(([key, group]) => [key, group.label]),
) as Record<ActionGroup, string>;

export const ACTIONS = {
  ...lifecycleSpecs,
  ...tabsSpecs,
  ...navigationSpecs,
  ...inspectSpecs,
  ...interactSpecs,
  ...waitSpecs,
  ...stateSpecs,
  ...batchSpecs,
} as Record<ActionName, ActionSpec>;
