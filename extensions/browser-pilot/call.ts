import type { BrowserPilotCall, BrowserPilotParams } from "./types";

/** Flatten the tool input into the action-specific shape used internally. */
export function flattenCall(call: BrowserPilotCall): BrowserPilotParams {
  const params = call.params ?? {};
  if (call.action === "help") {
    return {
      action: "help",
      ...(typeof params.group === "string" ? { group: params.group } : {}),
      ...(typeof params.action === "string" ? { help_action: params.action } : {}),
    } as BrowserPilotParams;
  }
  return { ...params, action: call.action } as BrowserPilotParams;
}

/** Read a string value from an action's parameter object. */
export function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
