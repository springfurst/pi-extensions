import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { BrowserPilotDetails, BrowserPilotToolResult, ChallengeInfo, TabInfo } from "./types";

/** Slice text to a character cap, reporting whether anything was cut. */
export function capText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean; chars: number } {
  if (text.length <= maxChars) return { text, truncated: false, chars: text.length };
  return { text: text.slice(0, maxChars), truncated: true, chars: text.length };
}

/** Apply pi's model-safe line and byte limits. */
export function capForModel(text: string): { text: string; truncated: boolean } {
  const result = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  return { text: result.content, truncated: result.truncated };
}

/** Apply the model-safe cap and wrap text with its structured details. */
export function finalize(text: string, details: BrowserPilotDetails): BrowserPilotToolResult {
  const capped = capForModel(text);
  const finalText = capped.truncated
    ? `${capped.text}\n\n[Output truncated by the model limit.]`
    : capped.text;
  return { content: [{ type: "text", text: finalText }], details };
}

/** A compact tab/URL/title header for an action result. */
export function pageHeader(tab: number, url: string, title: string): string {
  const suffix = title ? ` · ${JSON.stringify(title)}` : "";
  return `Tab ${tab} · ${url || "about:blank"}${suffix}`;
}

/** Label a non-binding suggestion. */
export function hint(text: string): string {
  return `Hint: ${text}`;
}

/** Label a suggested next step without making it sound mandatory. */
export function suggestedNext(text: string): string {
  return `Suggested next: ${text}`;
}

/** One-line challenge summary for the result footer. */
export function formatChallenge(challenge: ChallengeInfo | undefined): string | undefined {
  if (!challenge) return undefined;
  const evidence = challenge.evidence.length > 0 ? ` (${challenge.evidence.join(", ")})` : "";
  return `${challenge.type} ${challenge.severity} challenge detected${evidence}`;
}

/** Render the tab list used by status and tabs. */
export function formatTabs(tabs: TabInfo[], maxTabs: number): string {
  if (tabs.length === 0) return "Tabs: 0";
  const lines = [`Tabs: ${tabs.length}/${maxTabs}`];
  for (const tab of tabs) {
    const marker = tab.current ? "*" : " ";
    const owner = tab.owned ? "" : " (user)";
    const title = tab.title ? `  ${JSON.stringify(tab.title)}` : "";
    lines.push(`  ${marker} ${tab.handle}  ${tab.url || "about:blank"}${title}${owner}`);
  }
  return lines.join("\n");
}

/** A truncation footer that names the limit and the escape hatch. */
export function truncationHint(
  chars: number,
  maxChars: number,
  savedPath?: string,
  allowSavePath = true,
): string {
  const save = savedPath
    ? `; full output saved to ${savedPath}`
    : allowSavePath
      ? "; pass save_path to write the full output to a file"
      : "; raise max_chars or use har for a full capture";
  return `[Output truncated at ${maxChars} of ${chars} characters${save}.]`;
}
