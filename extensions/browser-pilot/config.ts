import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BrowserPilotConfig,
  BrowserPilotLoggingConfig,
  LoadBrowserPilotConfigOptions,
} from "./types";

/** Default shared profile name. */
export const DEFAULT_PROFILE = "shared";

/** Built-in defaults, before any config file. */
export const DEFAULT_BROWSER_PILOT_CONFIG: BrowserPilotConfig = {
  profile: DEFAULT_PROFILE,
  headless: "auto",
  viewport: { width: 1365, height: 768 },
  maxTabs: 8,
  tabOverflow: "nudge",
  navigationTimeoutSeconds: 30,
  actionTimeoutSeconds: 15,
  challengeWaitSeconds: 300,
  idleCloseSeconds: 0,
  closeOnExit: true,
  restoreTabs: true,
  stealth: "basic",
  humanize: false,
  allowPrivateHosts: true,
  maxReadChars: 50_000,
  maxEvalChars: 20_000,
  maxSnapshotNodes: 200,
  consoleBuffer: 200,
  networkBuffer: 200,
  args: [],
  noSandbox: false,
  logging: {
    enabled: false,
    includeArgs: true,
    includeSensitiveArgs: false,
    outputs: "summary",
    maxOutputChars: 2_000,
  },
};

const CONFIG_FILE_NAME = "browser-pilot.json";

/**
 * Load `browser-pilot.json` from the agent directory and, when the project is
 * trusted, from `<cwd>/.pi/`. Malformed values are ignored rather than
 * rejecting the whole file. Environment variables fill binary and profile
 * defaults when the file leaves them unset.
 */
export function loadBrowserPilotConfig(
  cwd: string,
  options: LoadBrowserPilotConfigOptions,
): BrowserPilotConfig {
  const global = readConfigFile(join(options.agentDir, CONFIG_FILE_NAME));
  const project = options.projectTrusted
    ? readConfigFile(join(cwd, ".pi", CONFIG_FILE_NAME))
    : undefined;
  const raw = { ...global, ...project };

  const config: BrowserPilotConfig = {
    ...DEFAULT_BROWSER_PILOT_CONFIG,
    viewport: { ...DEFAULT_BROWSER_PILOT_CONFIG.viewport },
    args: [],
    ...pickConfig(raw),
    logging: {
      ...DEFAULT_BROWSER_PILOT_CONFIG.logging,
      ...pickLogging(global?.logging),
      ...pickLogging(project?.logging),
    },
  };

  const env = options.env ?? process.env;
  config.executablePath ??=
    envString(env, "BROWSER_PILOT_EXECUTABLE_PATH") ??
    envString(env, "PUPPETEER_EXECUTABLE_PATH") ??
    envString(env, "CHROME_PATH");
  config.profile = envString(env, "BROWSER_PILOT_PROFILE") ?? config.profile;
  if (config.logging.dir === undefined) {
    config.logging.dir = join(options.agentDir, "browser-pilot", "logs");
  }
  return config;
}

type RawConfig = Record<string, unknown>;

function readConfigFile(path: string): RawConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function pickConfig(raw: RawConfig): Partial<BrowserPilotConfig> {
  const out: Partial<BrowserPilotConfig> = {};
  const executablePath = asNonEmptyString(raw.executablePath);
  if (executablePath !== undefined) out.executablePath = executablePath;
  const profile = asNonEmptyString(raw.profile);
  if (profile !== undefined) out.profile = profile;
  const headless = asHeadless(raw.headless);
  if (headless !== undefined) out.headless = headless;
  const viewport = asViewport(raw.viewport);
  if (viewport !== undefined) out.viewport = viewport;
  const locale = asNonEmptyString(raw.locale);
  if (locale !== undefined) out.locale = locale;
  const timezone = asNonEmptyString(raw.timezone);
  if (timezone !== undefined) out.timezone = timezone;
  const userAgent = asNonEmptyString(raw.userAgent);
  if (userAgent !== undefined) out.userAgent = userAgent;
  const maxTabs = asPositiveNumber(raw.maxTabs);
  if (maxTabs !== undefined) out.maxTabs = Math.floor(maxTabs);
  const tabOverflow = asTabOverflow(raw.tabOverflow);
  if (tabOverflow !== undefined) out.tabOverflow = tabOverflow;
  const navigationTimeoutSeconds = asPositiveNumber(raw.navigationTimeoutSeconds);
  if (navigationTimeoutSeconds !== undefined)
    out.navigationTimeoutSeconds = navigationTimeoutSeconds;
  const actionTimeoutSeconds = asPositiveNumber(raw.actionTimeoutSeconds);
  if (actionTimeoutSeconds !== undefined) out.actionTimeoutSeconds = actionTimeoutSeconds;
  const challengeWaitSeconds = asPositiveNumber(raw.challengeWaitSeconds);
  if (challengeWaitSeconds !== undefined) out.challengeWaitSeconds = challengeWaitSeconds;
  const idleCloseSeconds = asNonNegativeNumber(raw.idleCloseSeconds);
  if (idleCloseSeconds !== undefined) out.idleCloseSeconds = idleCloseSeconds;
  const closeOnExit = asBoolean(raw.closeOnExit);
  if (closeOnExit !== undefined) out.closeOnExit = closeOnExit;
  const restoreTabs = asBoolean(raw.restoreTabs);
  if (restoreTabs !== undefined) out.restoreTabs = restoreTabs;
  const stealth = asStealth(raw.stealth);
  if (stealth !== undefined) out.stealth = stealth;
  const humanize = asBoolean(raw.humanize);
  if (humanize !== undefined) out.humanize = humanize;
  const allowPrivateHosts = asBoolean(raw.allowPrivateHosts);
  if (allowPrivateHosts !== undefined) out.allowPrivateHosts = allowPrivateHosts;
  const screenshotsDir = asNonEmptyString(raw.screenshotsDir);
  if (screenshotsDir !== undefined) out.screenshotsDir = screenshotsDir;
  const maxReadChars = asPositiveNumber(raw.maxReadChars);
  if (maxReadChars !== undefined) out.maxReadChars = Math.floor(maxReadChars);
  const maxEvalChars = asPositiveNumber(raw.maxEvalChars);
  if (maxEvalChars !== undefined) out.maxEvalChars = Math.floor(maxEvalChars);
  const maxSnapshotNodes = asPositiveNumber(raw.maxSnapshotNodes);
  if (maxSnapshotNodes !== undefined) out.maxSnapshotNodes = Math.floor(maxSnapshotNodes);
  const consoleBuffer = asPositiveNumber(raw.consoleBuffer);
  if (consoleBuffer !== undefined) out.consoleBuffer = Math.floor(consoleBuffer);
  const networkBuffer = asPositiveNumber(raw.networkBuffer);
  if (networkBuffer !== undefined) out.networkBuffer = Math.floor(networkBuffer);
  const args = asStringArray(raw.args);
  if (args !== undefined) out.args = args;
  const noSandbox = asBoolean(raw.noSandbox);
  if (noSandbox !== undefined) out.noSandbox = noSandbox;
  return out;
}

function pickLogging(raw: unknown): Partial<BrowserPilotLoggingConfig> {
  const record = asRecord(raw);
  if (!record) return {};
  const out: Partial<BrowserPilotLoggingConfig> = {};
  const enabled = asBoolean(record.enabled);
  if (enabled !== undefined) out.enabled = enabled;
  const dir = asNonEmptyString(record.dir);
  if (dir !== undefined) out.dir = dir;
  const includeArgs = asBoolean(record.includeArgs);
  if (includeArgs !== undefined) out.includeArgs = includeArgs;
  const includeSensitiveArgs = asBoolean(record.includeSensitiveArgs);
  if (includeSensitiveArgs !== undefined) out.includeSensitiveArgs = includeSensitiveArgs;
  const outputs = asOutputMode(record.outputs);
  if (outputs !== undefined) out.outputs = outputs;
  const maxOutputChars = asPositiveNumber(record.maxOutputChars);
  if (maxOutputChars !== undefined) out.maxOutputChars = Math.floor(maxOutputChars);
  return out;
}

function envString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return asNonEmptyString(env[name]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return items.length === value.length ? items.map((item) => item.trim()) : undefined;
}

function asHeadless(value: unknown): boolean | "auto" | undefined {
  if (value === "auto") return "auto";
  return typeof value === "boolean" ? value : undefined;
}

function asViewport(value: unknown): { width: number; height: number } | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const width = asPositiveNumber(record.width);
  const height = asPositiveNumber(record.height);
  if (width === undefined || height === undefined) return undefined;
  return { width: Math.floor(width), height: Math.floor(height) };
}

function asTabOverflow(value: unknown): BrowserPilotConfig["tabOverflow"] | undefined {
  return value === "nudge" || value === "close-lru" || value === "reuse-blank" ? value : undefined;
}

function asStealth(value: unknown): BrowserPilotConfig["stealth"] | undefined {
  return value === "off" || value === "basic" || value === "careful" ? value : undefined;
}

function asOutputMode(value: unknown): BrowserPilotLoggingConfig["outputs"] | undefined {
  return value === "none" || value === "summary" || value === "snippet" || value === "full"
    ? value
    : undefined;
}
