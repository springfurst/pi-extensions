import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { LoggingConfig } from "./config";

/** Version of the usage-record schema; bump when a field changes meaning. */
export const USAGE_SCHEMA_VERSION = 1;

/** Fields common to every tool's usage record. */
export interface UsageRecordBase {
  schema: number;
  timestamp: string;
  tool: string;
  toolVersion: string;
  piVersion: string;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  toolCallId?: string;
  cwd: string;
  mode?: string;
  durationMs: number;
  outcome: "ok" | "error";
  error?: string;
}

/** A complete usage record: the shared envelope plus tool-specific fields. */
export interface UsageRecord extends UsageRecordBase {
  [key: string]: unknown;
}

/** Receives completed usage records. Implementations must not throw. */
export interface UsageLogger {
  log(record: UsageRecord): void;
}

/** Expand a leading `~` to the user's home directory. */
export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Directory holding the per-tool JSONL files. Defaults to
 * `<agentDir>/web-tools/usage`; a configured path may be absolute, relative to
 * the working directory, or start with `~`.
 */
export function resolveUsageDir(
  cwd: string,
  agentDir: string,
  config: Pick<LoggingConfig, "dir">,
): string {
  const raw = config.dir ?? join(agentDir, "web-tools", "usage");
  const expanded = expandTilde(raw);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/** Path of one tool's append-only JSONL file inside the usage directory. */
export function usageFilePath(dir: string, tool: string): string {
  return join(dir, `${tool}.jsonl`);
}

/** Serialize one record as a single JSON line. */
export function serializeUsageRecord(record: UsageRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Append one record to a JSONL file, creating the parent directory as needed.
 * Best-effort: every filesystem error is swallowed so logging can never affect
 * or delay the tool result.
 */
export function appendUsageRecord(filePath: string, record: UsageRecord): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    appendFileSync(filePath, serializeUsageRecord(record), { mode: 0o600 });
  } catch {
    // Logging is best-effort by contract.
  }
}

/** Build a best-effort writer for one tool's JSONL file. */
export function createFileUsageLogger(options: {
  cwd: string;
  agentDir: string;
  tool: string;
  config: Pick<LoggingConfig, "dir">;
}): UsageLogger {
  const filePath = usageFilePath(
    resolveUsageDir(options.cwd, options.agentDir, options.config),
    options.tool,
  );
  return {
    log(record) {
      appendUsageRecord(filePath, record);
    },
  };
}
