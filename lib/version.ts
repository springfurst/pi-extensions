import { readFileSync } from "node:fs";

/**
 * Read this package's version from its `package.json`. The file ships alongside
 * the compiled sources, so the path is stable at runtime. A missing or
 * unreadable file falls back to `"0.0.0"` rather than failing the tool.
 */
function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // Fall through to the placeholder.
  }
  return "0.0.0";
}

/** This package's version, read once at module load. */
export const TOOL_VERSION = readPackageVersion();
