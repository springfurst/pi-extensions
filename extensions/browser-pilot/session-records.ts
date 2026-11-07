import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

export function writeSessionRecord(path: string, record: SessionRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      `${JSON.stringify(record, null, 2)}
`,
      { mode: 0o600 },
    );
  } catch {
    // Session state is an optimization; never fail a tool call over it.
  }
}

export function removeSessionRecord(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort.
  }
}
