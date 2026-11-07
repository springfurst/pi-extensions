import type { ActionGroup, ActionName, ActionSpec } from "./spec-types";
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
export type { ActionGroup, ActionName, ActionSpec, ParamSpec } from "./spec-types";

export const GROUP_LABELS: Record<ActionGroup, string> = {
  lifecycle: "Lifecycle",
  tabs: "Tabs",
  navigation: "Navigation",
  inspect: "Inspect",
  interact: "Interact",
  wait: "Wait",
  state: "State",
  batch: "Batch",
};

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
