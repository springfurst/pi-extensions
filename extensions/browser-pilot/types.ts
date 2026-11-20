import type { Page } from "puppeteer-core";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { LoggingConfig } from "../../lib/config";
import type { ChromeInstance, InstanceRecord, ProfileInfo } from "../../lib/browser/profile";
export type { ChromeInstance, InstanceRecord, ProfileInfo };
import type {
  BlockingConfig,
  HostPolicy,
  PolitenessConfig,
  RuntimeConfig,
} from "../../lib/web/config";
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
  /** Tab handle that captured the request. */
  tab?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  timing?: unknown;
  responseBody?: string;
  responseBodyTruncated?: boolean;
}

/** One download observed by the browser. */
export interface DownloadInfo {
  id: string;
  url: string;
  suggestedFilename: string;
  state: "inProgress" | "completed" | "canceled";
  receivedBytes: number;
  totalBytes: number;
  path: string;
  startedAt: string;
  completedAt?: string;
}

/** One intercepted request rule. */
export interface RouteRule {
  id: string;
  urlPattern: string;
  resourceType?: string;
  action: "abort" | "continue" | "fulfill" | "delay";
  status?: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  delayMs?: number;
}

/** A viewport and media emulation override. */
export interface EmulationState {
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
  };
  userAgent?: string;
  locale?: string;
  timezone?: string;
  colorScheme?: "light" | "dark" | "no-preference";
  reducedMotion?: "reduce" | "no-preference";
  network?: { offline?: boolean; latency: number; download: number; upload: number } | null;
  cpuThrottle?: number;
  geolocation?: { latitude: number; longitude: number; accuracy?: number } | null;
  permissions?: { origin: string; values: string[] } | null;
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
  /** One-line description of the element an action targeted, such as `button "Sign in"`. */
  subject?: string;
  /** One-line preview of what an action read, wrote, or evaluated. */
  preview?: string;
  challenge?: ChallengeInfo;
  truncated?: boolean;
  savedPath?: string;
  /** True when the result contains page-derived text. */
  pageText?: boolean;
  tabs?: TabInfo[];
  notes?: string[];
  durationMs?: number;
  error?: string;
  [key: string]: unknown;
}

/** A tool result: model-facing content plus structured details. */
export interface BrowserPilotToolResult {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details: BrowserPilotDetails;
  isError?: boolean;
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

/** The tool input: one action plus its action-specific parameters. */
export interface BrowserPilotCall {
  action: ActionName;
  params?: Record<string, unknown>;
}

/** The flat internal shape shared by every action handler. */
export interface BrowserPilotParams {
  action: ActionName;
  group?: string;
  help_action?: string;
  profile?: string;
  url?: string;
  direction?: "back" | "forward" | "reload" | "up" | "down" | "top" | "bottom";
  wait_until?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
  operation?: string;
  target?: "tab" | "tabs" | "browser";
  tab?: number;
  frame?: number;
  interactive?: boolean;
  max_nodes?: number;
  format?: "markdown" | "text" | "html" | "outline" | "png" | "jpeg" | "webp";
  max_chars?: number;
  save_path?: string;
  endpoint?: string;
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
  duration_ms?: number;
  key?: string;
  values?: string[];
  pixels?: number;
  until?: "selector" | "text" | "url" | "network_idle" | "function" | "human" | "response";
  path?: string;
  full_page?: boolean;
  quality?: number;
  inline_image?: boolean;
  annotate?: boolean;
  level?: string;
  limit?: number;
  filter?: string;
  stack_traces?: boolean;
  include_body?: boolean;
  policy?: "dismiss" | "accept" | "manual";
  timeout_ms?: number;
  files?: string[];
  storage_area?: "local" | "session";
  name?: string;
  value?: string;
  domain?: string;
  cookie_path?: string;
  expires?: number;
  http_only?: boolean;
  secure?: boolean;
  same_site?: "Strict" | "Lax" | "None";
  width?: number;
  height?: number;
  device_scale_factor?: number;
  is_mobile?: boolean;
  has_touch?: boolean;
  user_agent?: string;
  locale?: string;
  timezone?: string;
  color_scheme?: "light" | "dark" | "no-preference";
  reduced_motion?: "reduce" | "no-preference";
  network_profile?: "offline" | "slow3g" | "fast3g" | "slow4g" | "fast4g";
  latency?: number;
  download_throughput?: number;
  upload_throughput?: number;
  cpu_throttle?: number;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  permissions?: string[];
  origin?: string;
  color?: string;
  reset?: boolean;
  paper_format?: string;
  landscape?: boolean;
  print_background?: boolean;
  scale?: number;
  page_ranges?: string;
  margin?: string;
  url_pattern?: string;
  resource_type?: string;
  route_action?: "abort" | "continue" | "fulfill" | "delay";
  response_status?: number;
  response_body?: string;
  response_content_type?: string;
  response_headers?: Record<string, string>;
  request_id?: string;
  rule_id?: string;
  check?: string;
  expected?: string | number | boolean;
  operator?: string;
  attribute?: string;
  steps?: BrowserPilotCall[];
  stop_on_error?: boolean;
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
  /** Allow navigation to local files that match `localFileGlobs`. */
  allowLocalFiles: boolean;
  /** Globs of local files that may be opened; relative globs resolve against the working directory. */
  localFileGlobs: string[];
  screenshotsDir?: string;
  downloadsDir?: string;
  exportsDir?: string;
  maxReadChars: number;
  maxEvalChars: number;
  maxSnapshotNodes: number;
  consoleBuffer: number;
  networkBuffer: number;
  args: string[];
  noSandbox: boolean;
  logging: BrowserPilotLoggingConfig;
  runtime: RuntimeConfig;
  politeness: PolitenessConfig;
  hosts: Record<string, HostPolicy>;
  blocking: BlockingConfig;
}

/** Options for loading the config. */
export interface LoadBrowserPilotConfigOptions {
  agentDir: string;
  projectTrusted: boolean;
  /** Environment source; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}
