import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Default engine priority when Aggregation is on and no explicit selection is configured. */
export const DEFAULT_SEARCH_ENGINES = ["duckduckgo", "startpage", "searxng", "google"] as const;

/** Default response byte cap for `web_fetch` (50 MiB). */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export interface FetchConfig {
  /** Maximum rendered characters kept from one fetch. */
  maxChars: number;
  /** Wall-clock fetch deadline in seconds. */
  timeoutSeconds: number;
  /** Maximum response bytes read for one fetch. */
  maxBytes: number;
  /** Enable remote reader fallbacks such as Jina. */
  remoteFallbacks: boolean;
  /** Use `trafilatura`/`lynx` when they are on `PATH`. */
  externalReaders: boolean;
  /** Disable the SSRF guard for local development. */
  allowPrivateHosts: boolean;
}

export interface SearchConfig {
  /** Active engine ids, in priority order. */
  engines: string[];
  /** Merge results across engines. */
  aggregate: boolean;
  /** Default result count. */
  limit: number;
  /** Per-engine transport deadline in seconds. */
  timeoutSeconds: number;
  /** Result cache time-to-live in seconds. */
  cacheTtlSeconds: number;
  /** Explicit engine override. */
  provider?: string;
}

export interface SearxngConfig {
  endpoint?: string;
  token?: string;
  basicUsername?: string;
  basicPassword?: string;
  categories?: string;
  engines?: string;
  language?: string;
  safesearch?: 0 | 1 | 2;
}

export interface BrowserConfig {
  /** Enable browser rendering when a browser binary resolves. */
  enabled: boolean;
  /** Pin a specific Chrome/Chromium executable. */
  executablePath?: string;
  /** Reserved for future stealth patches; currently only a navigation baseline is applied. */
  stealth: boolean;
  /** Disable the Chromium sandbox for root/container environments. */
  noSandbox: boolean;
  /** Per-render navigation deadline in seconds. */
  timeoutSeconds: number;
  /** Close the shared browser after this many idle seconds; `0` disables idle close. */
  idleCloseSeconds: number;
  /** Maximum number of concurrent browser pages. */
  maxPages: number;
  /** Permit private/loopback hosts in the browser, mirroring `fetch.allowPrivateHosts`. */
  allowPrivateHosts: boolean;
}

export interface WebToolsConfig {
  fetch: FetchConfig;
  search: SearchConfig;
  searxng: SearxngConfig;
  browser: BrowserConfig;
}

/** Built-in defaults, before any config file. */
export const DEFAULT_CONFIG: WebToolsConfig = {
  fetch: {
    maxChars: 500_000,
    timeoutSeconds: 30,
    maxBytes: DEFAULT_MAX_BYTES,
    remoteFallbacks: false,
    externalReaders: true,
    allowPrivateHosts: false,
  },
  search: {
    engines: [...DEFAULT_SEARCH_ENGINES],
    aggregate: true,
    limit: 10,
    timeoutSeconds: 60,
    cacheTtlSeconds: 300,
  },
  searxng: {},
  browser: {
    enabled: true,
    stealth: false,
    noSandbox: false,
    timeoutSeconds: 20,
    idleCloseSeconds: 120,
    maxPages: 2,
    allowPrivateHosts: false,
  },
};

export interface LoadConfigOptions {
  /** pi's agent directory, normally `getAgentDir()`. */
  agentDir: string;
  /** Whether a project-local config file may be read. */
  projectTrusted: boolean;
}

const PROJECT_CONFIG_DIR = ".pi";
const CONFIG_FILE_NAME = "web-tools.json";

/**
 * Load `web-tools.json` from the agent directory and, when the project is
 * trusted, from `<cwd>/.pi/`. Environment variables supply the SearXNG
 * connection when the file leaves it unset. Malformed values are ignored
 * rather than rejecting the whole file.
 */
export function loadConfig(cwd: string, options: LoadConfigOptions): WebToolsConfig {
  const global = readConfigFile(join(options.agentDir, CONFIG_FILE_NAME));
  const project = options.projectTrusted
    ? readConfigFile(join(cwd, PROJECT_CONFIG_DIR, CONFIG_FILE_NAME))
    : undefined;

  const config: WebToolsConfig = {
    fetch: {
      ...DEFAULT_CONFIG.fetch,
      ...pickFetch(global?.fetch),
      ...pickFetch(project?.fetch),
    },
    search: {
      ...DEFAULT_CONFIG.search,
      ...pickSearch(global?.search),
      ...pickSearch(project?.search),
    },
    searxng: {
      ...pickSearxng(global?.searxng),
      ...pickSearxng(project?.searxng),
    },
    browser: {
      ...DEFAULT_CONFIG.browser,
      ...pickBrowser(global?.browser),
      ...pickBrowser(project?.browser),
    },
  };

  config.searxng = { ...config.searxng, ...searxngFromEnv(config.searxng) };
  return config;
}

interface RawConfig {
  fetch?: Record<string, unknown>;
  search?: Record<string, unknown>;
  searxng?: Record<string, unknown>;
  browser?: Record<string, unknown>;
}

function readConfigFile(path: string): RawConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    const record = asRecord(parsed);
    if (!record) return undefined;
    return {
      fetch: asRecord(record.fetch),
      search: asRecord(record.search),
      searxng: asRecord(record.searxng),
      browser: asRecord(record.browser),
    };
  } catch {
    // A malformed or unreadable config file falls back to the defaults.
    return undefined;
  }
}

function pickFetch(raw: Record<string, unknown> | undefined): Partial<FetchConfig> {
  if (!raw) return {};
  const out: Partial<FetchConfig> = {};
  const maxChars = asPositiveNumber(raw.maxChars);
  if (maxChars !== undefined) out.maxChars = maxChars;
  const timeoutSeconds = asPositiveNumber(raw.timeoutSeconds);
  if (timeoutSeconds !== undefined) out.timeoutSeconds = timeoutSeconds;
  const maxBytes = asPositiveNumber(raw.maxBytes);
  if (maxBytes !== undefined) out.maxBytes = maxBytes;
  const remoteFallbacks = asBoolean(raw.remoteFallbacks);
  if (remoteFallbacks !== undefined) out.remoteFallbacks = remoteFallbacks;
  const externalReaders = asBoolean(raw.externalReaders);
  if (externalReaders !== undefined) out.externalReaders = externalReaders;
  const allowPrivateHosts = asBoolean(raw.allowPrivateHosts);
  if (allowPrivateHosts !== undefined) out.allowPrivateHosts = allowPrivateHosts;
  return out;
}

function pickSearch(raw: Record<string, unknown> | undefined): Partial<SearchConfig> {
  if (!raw) return {};
  const out: Partial<SearchConfig> = {};
  const engines = asStringArray(raw.engines);
  if (engines && engines.length > 0) out.engines = engines;
  const aggregate = asBoolean(raw.aggregate);
  if (aggregate !== undefined) out.aggregate = aggregate;
  const limit = asPositiveNumber(raw.limit);
  if (limit !== undefined) out.limit = Math.floor(limit);
  const timeoutSeconds = asPositiveNumber(raw.timeoutSeconds);
  if (timeoutSeconds !== undefined) out.timeoutSeconds = timeoutSeconds;
  const cacheTtlSeconds = asNonNegativeNumber(raw.cacheTtlSeconds);
  if (cacheTtlSeconds !== undefined) out.cacheTtlSeconds = cacheTtlSeconds;
  const provider = asNonEmptyString(raw.provider);
  if (provider !== undefined) out.provider = provider;
  return out;
}

function pickBrowser(raw: Record<string, unknown> | undefined): Partial<BrowserConfig> {
  if (!raw) return {};
  const out: Partial<BrowserConfig> = {};
  const enabled = asBoolean(raw.enabled);
  if (enabled !== undefined) out.enabled = enabled;
  const executablePath = asNonEmptyString(raw.executablePath);
  if (executablePath !== undefined) out.executablePath = executablePath;
  const stealth = asBoolean(raw.stealth);
  if (stealth !== undefined) out.stealth = stealth;
  const noSandbox = asBoolean(raw.noSandbox);
  if (noSandbox !== undefined) out.noSandbox = noSandbox;
  const timeoutSeconds = asPositiveNumber(raw.timeoutSeconds);
  if (timeoutSeconds !== undefined) out.timeoutSeconds = timeoutSeconds;
  const idleCloseSeconds = asNonNegativeNumber(raw.idleCloseSeconds);
  if (idleCloseSeconds !== undefined) out.idleCloseSeconds = idleCloseSeconds;
  const maxPages = asPositiveNumber(raw.maxPages);
  if (maxPages !== undefined) out.maxPages = Math.max(1, Math.floor(maxPages));
  const allowPrivateHosts = asBoolean(raw.allowPrivateHosts);
  if (allowPrivateHosts !== undefined) out.allowPrivateHosts = allowPrivateHosts;
  return out;
}

function pickSearxng(raw: Record<string, unknown> | undefined): SearxngConfig {
  if (!raw) return {};
  const out: SearxngConfig = {};
  const endpoint = asNonEmptyString(raw.endpoint);
  if (endpoint !== undefined) out.endpoint = endpoint;
  const token = asNonEmptyString(raw.token);
  if (token !== undefined) out.token = token;
  const basicUsername = asNonEmptyString(raw.basicUsername);
  if (basicUsername !== undefined) out.basicUsername = basicUsername;
  const basicPassword = asNonEmptyString(raw.basicPassword);
  if (basicPassword !== undefined) out.basicPassword = basicPassword;
  const categories = asNonEmptyString(raw.categories);
  if (categories !== undefined) out.categories = categories;
  const engines = asNonEmptyString(raw.engines);
  if (engines !== undefined) out.engines = engines;
  const language = asNonEmptyString(raw.language);
  if (language !== undefined) out.language = language;
  const safesearch = asSafesearch(raw.safesearch);
  if (safesearch !== undefined) out.safesearch = safesearch;
  return out;
}

/** Apply environment fallbacks for values the file left unset. */
function searxngFromEnv(config: SearxngConfig): SearxngConfig {
  const out: SearxngConfig = {};
  if (config.endpoint === undefined && process.env.SEARXNG_ENDPOINT)
    out.endpoint = process.env.SEARXNG_ENDPOINT;
  if (config.token === undefined && process.env.SEARXNG_TOKEN)
    out.token = process.env.SEARXNG_TOKEN;
  if (config.basicUsername === undefined && process.env.SEARXNG_BASIC_USERNAME) {
    out.basicUsername = process.env.SEARXNG_BASIC_USERNAME;
  }
  if (config.basicPassword === undefined && process.env.SEARXNG_BASIC_PASSWORD) {
    out.basicPassword = process.env.SEARXNG_BASIC_PASSWORD;
  }
  return out;
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

function asSafesearch(value: unknown): 0 | 1 | 2 | undefined {
  return value === 0 || value === 1 || value === 2 ? value : undefined;
}
