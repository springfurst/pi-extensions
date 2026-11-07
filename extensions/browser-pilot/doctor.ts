import { accessSync, constants as fsConstants, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveBrowserExecutable } from "../../lib/browser";
import {
  instanceRecordPath,
  pidAlive,
  probeInstance,
  readInstanceRecord,
  shouldRunHeadless,
} from "./launcher";
import { finalize, hint } from "./output";
import { previewProfile, type BrowserPilotSession } from "./session";
import { resolvePath } from "./tool-helpers";
import type { BrowserPilotConfig, BrowserPilotToolResult } from "./types";

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

interface DoctorCheck {
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export async function doctorResult(
  session: BrowserPilotSession,
  config: BrowserPilotConfig,
): Promise<BrowserPilotToolResult> {
  const checks: DoctorCheck[] = [];
  const executable = config.executablePath
    ? resolvePath(session.cwd, config.executablePath)
    : undefined;
  const binary = await resolveBrowserExecutable({
    executablePath: executable,
    preferConfigured: true,
  }).catch(() => undefined);
  const binaryExists = binary ? isFile(binary) : false;
  checks.push(
    binary && binaryExists
      ? { label: "browser binary", status: "ok", detail: binary }
      : {
          label: "browser binary",
          status: "fail",
          detail: binary
            ? `${binary} does not exist or is not a file`
            : "no Chrome, Chromium, or Edge found; set executablePath or BROWSER_PILOT_EXECUTABLE_PATH",
        },
  );

  const profile =
    session.profile ?? previewProfile(config, session.sessionId, session.agentDir, session.cwd);
  checks.push({
    label: "profile",
    status: "ok",
    detail: `${profile.label} (${profile.userDataDir}) ${profile.persistent ? "persistent" : "isolated"}`,
  });

  const record = readInstanceRecord(instanceRecordPath(session.agentDir, profile.key));
  if (!record) {
    checks.push({ label: "instance", status: "ok", detail: "no live instance record" });
  } else if (!pidAlive(record.pid)) {
    checks.push({
      label: "instance",
      status: "warn",
      detail: `stale record for pid ${record.pid}; the next open will replace it`,
    });
  } else {
    const probe = await probeInstance(record.port).catch(() => undefined);
    if (!probe) {
      checks.push({
        label: "instance",
        status: "warn",
        detail: `pid ${record.pid} is alive but port ${record.port} is not responding; the next open will replace it`,
      });
    } else {
      const same = !record.ownerSessionId || record.ownerSessionId === session.sessionId;
      checks.push({
        label: "instance",
        status: same ? "ok" : "warn",
        detail: `pid ${record.pid}, port ${record.port}${record.ownerSessionId ? `, session ${record.ownerSessionId}` : ""}${same ? "" : " (owned by another session)"}`,
      });
    }
  }

  checks.push(
    session.instance
      ? {
          label: "session",
          status: session.browser?.connected ? "ok" : "warn",
          detail: `pid ${session.instance.pid}, port ${session.instance.port}, ${session.browser?.connected ? "connected" : "disconnected"}`,
        }
      : { label: "session", status: "ok", detail: "not started" },
  );

  const headless = shouldRunHeadless(config);
  checks.push({
    label: "display",
    status: headless ? "warn" : "ok",
    detail: headless ? "headless mode; human handoff is unavailable" : "headful mode",
  });

  const root = typeof process.getuid === "function" && process.getuid() === 0;
  checks.push({
    label: "sandbox",
    status: root && !config.noSandbox ? "warn" : "ok",
    detail: config.noSandbox
      ? "no-sandbox enabled"
      : root
        ? "running as root without no-sandbox"
        : "default sandbox",
  });

  const dirs: Array<[string, string]> = [
    [
      "screenshots",
      config.screenshotsDir
        ? resolvePath(session.cwd, config.screenshotsDir)
        : join(session.agentDir, "browser-pilot", "screenshots"),
    ],
    ["downloads", session.downloadsDir()],
    ["exports", session.exportsDir()],
    [
      "logs",
      resolvePath(
        session.cwd,
        config.logging.dir ?? join(session.agentDir, "browser-pilot", "logs"),
      ),
    ],
    ...(profile.userDataDir ? [["profile", profile.userDataDir] as [string, string]] : []),
  ];
  for (const [label, dir] of dirs) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      accessSync(dir, fsConstants.W_OK);
      checks.push({ label: `${label} directory`, status: "ok", detail: dir });
    } catch (error) {
      checks.push({
        label: `${label} directory`,
        status: "fail",
        detail: `${dir} (${error instanceof Error ? error.message : String(error)})`,
      });
    }
  }

  const lines = ["Browser Pilot doctor", ""];
  for (const check of checks) {
    const marker = check.status === "ok" ? "OK" : check.status === "warn" ? "WARN" : "FAIL";
    lines.push(`${marker} ${check.label}: ${check.detail}`);
  }
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  lines.push(
    "",
    failures > 0
      ? `${failures} blocking issue(s), ${warnings} warning(s).`
      : warnings > 0
        ? `${warnings} warning(s); the browser can still run.`
        : "All checks passed.",
  );
  if (failures > 0) lines.push(hint("fix the FAIL lines before calling open."));
  return finalize(lines.join("\n"), {
    action: "doctor",
    checks,
    failures,
    warnings,
    profile: profile.label,
    userDataDir: profile.userDataDir,
    headless,
  });
}
