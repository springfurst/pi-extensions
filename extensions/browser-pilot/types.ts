import type { Page } from "puppeteer-core";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { LoggingConfig } from "../../lib/config";
import type { ActionName } from "./actions";

/** An expected failure with an optional, non-binding hint for the agent. */
export class BrowserPilotError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "BrowserPilotError";
  }
}

/** Where a profile lives and whether it survives the session. */
export interface ProfileInfo {
  /** Short stable key used for the instance record filename. */
  key: string;
  /** Absolute user-data-dir. */
  userDataDir: string;
  /** Human-facing profile name or path. */
  label: string;
  /** True when the profile is reused across sessions. */
  persistent: boolean;
}

/** One live Chrome process and its DevTools endpoint. */
export interface ChromeInstance {
  pid: number;
  port: number;
  wsEndpoint: string;
  userDataDir: string;
  executablePath: string;
  startedAt: string;
  ownerSessionId: string;
  chromeVersion?: string;
}

/** Persisted per-profile instance record. */
export interface InstanceRecord extends ChromeInstance {
  schema: number;
}

/** Persisted per-session tab state, used to reattach after a reload. */
export interface SessionRecord {
  schema: number;
  sessionId: string;
  profileKey: string;
  wsEndpoint: string;
  currentTab?: number;
  tabs: Array<{ handle: number; targetId: string; url: string; owned: boolean }>;
}

/** One tab exposed to the agent. */
export interface TabInfo {
  handle: number;
  targetId: string;
  url: string;
  title: string;
  current: boolean;
  owned: boolean;
  lastUsed: number;
}

/** One captured console entry. */
export interface ConsoleEntry {
  timestamp: string;
  level: string;
  text: string;
  url?: string;
  line?: number;
  stack?: string;
}

/** One captured network entry. */
export interface NetworkEntry {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  size?: number;
  durationMs?: number;
  failed?: string;
  startedAt: number;
}

/** A dialog waiting for a decision. */
export interface DialogInfo {
  type: string;
  message: string;
  defaultValue?: string;
  openedAt: string;
}

/** A detected CAPTCHA or bot challenge. */
export interface ChallengeInfo {
  type: string;
  severity: "blocking" | "present";
  evidence: string[];
  url: string;
  title: string;
}

/** Structured state returned with every tool result for rendering and scripts. */
export interface BrowserPilotDetails {
  action: string;
  tab?: number;
  url?: string;
  title?: string;
  status?: number;
  challenge?: ChallengeInfo;
  truncated?: boolean;
  savedPath?: string;
  tabs?: TabInfo[];
  notes?: string[];
  durationMs?: number;
  error?: string;
  [key: string]: unknown;
}

/** Everything one tool call needs from pi and the caller. */
export interface BrowserPilotContext {
  cwd: string;
  agentDir: string;
  trusted: boolean;
  signal?: AbortSignal;
  toolCallId?: string;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  mode?: string;
  onUpdate?: AgentToolUpdateCallback<BrowserPilotDetails>;
}

/** A page plus the bookkeeping the session keeps for it. */
export interface ManagedTab {
  handle: number;
  targetId: string;
  page: Page;
  owned: boolean;
  lastUsed: number;
  opener?: number;
  console: ConsoleEntry[];
  network: NetworkEntry[];
}

/** The logging section of the browser-pilot configuration. */
export interface BrowserPilotLoggingConfig extends LoggingConfig {
  /** `none`, `summary`, `snippet`, or `full`. */
  outputs: "none" | "summary" | "snippet" | "full";
  /** Cap for snippet/full output written to the JSONL record. */
  maxOutputChars: number;
  /** Include typed text, eval source, and other sensitive arguments. */
  includeSensitiveArgs: boolean;
}

/** The flat tool input shared by every action. */
export interface BrowserPilotParams {
  action: ActionName;
  topic?: string;
  profile?: string;
  url?: string;
  direction?: "back" | "forward" | "reload" | "up" | "down" | "top" | "bottom";
  wait_until?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
  op?: string;
  target?: "tab" | "tabs" | "browser";
  tab?: number;
  interactive?: boolean;
  max_nodes?: number;
  format?: "markdown" | "text" | "html" | "png" | "jpeg" | "webp";
  max_chars?: number;
  save_path?: string;
  expression?: string;
  script_path?: string;
  await_promise?: boolean;
  ref?: string;
  selector?: string;
  button?: "left" | "right" | "middle";
  click_count?: number;
  modifiers?: string[];
  humanize?: boolean;
  text?: string;
  text_file?: string;
  text_env?: string;
  clear?: boolean;
  submit?: boolean;
  delay_ms?: number;
  key?: string;
  values?: string[];
  amount?: number;
  for?: "selector" | "text" | "url" | "network_idle" | "function" | "human";
  path?: string;
  full_page?: boolean;
  quality?: number;
  inline?: boolean;
  level?: string;
  limit?: number;
  filter?: string;
  policy?: "dismiss" | "accept" | "manual";
  timeout_ms?: number;
}

/** Configuration for one browser-pilot call. */
export interface BrowserPilotConfig {
  executablePath?: string;
  profile: string;
  headless: boolean | "auto";
  viewport: { width: number; height: number };
  locale?: string;
  timezone?: string;
  userAgent?: string;
  maxTabs: number;
  tabOverflow: "nudge" | "close-lru" | "reuse-blank";
  navigationTimeoutSeconds: number;
  actionTimeoutSeconds: number;
  challengeWaitSeconds: number;
  idleCloseSeconds: number;
  closeOnExit: boolean;
  restoreTabs: boolean;
  stealth: "off" | "basic" | "careful";
  humanize: boolean;
  allowPrivateHosts: boolean;
  screenshotsDir?: string;
  maxReadChars: number;
  maxEvalChars: number;
  maxSnapshotNodes: number;
  consoleBuffer: number;
  networkBuffer: number;
  args: string[];
  noSandbox: boolean;
  logging: BrowserPilotLoggingConfig;
}

/** Options for loading the config. */
export interface LoadBrowserPilotConfigOptions {
  agentDir: string;
  projectTrusted: boolean;
  /** Environment source; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}
