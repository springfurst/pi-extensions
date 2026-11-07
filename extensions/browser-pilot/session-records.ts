import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sanitizeFile } from "./session-helpers";
import type { SessionRecord } from "./types";

export const SESSION_SCHEMA = 1;

export function sessionRecordPath(agentDir: string, sessionId: string): string {
  return join(agentDir, "browser-pilot", "sessions", `${sanitizeFile(sessionId)}.json`);
}

export function readSessionRecord(path: string): SessionRecord | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SessionRecord>;
    if (
      parsed.schema !== SESSION_SCHEMA ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.wsEndpoint !== "string" ||
      !Array.isArray(parsed.tabs)
    ) {
      return undefined;
    }
    return parsed as SessionRecord;
  } catch {
    return undefined;
  }
}

export function removeSessionRecord(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort.
  }
}
