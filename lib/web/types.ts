/**
 * The contract exchanged between the web tools and the runtime that serves them.
 *
 * `web_fetch`, `web_search`, and `browser-pilot` are adapters over one shared
 * runtime; this module is the vocabulary they agree on. It holds no behavior,
 * so every layer can depend on it without pulling in a transport or a browser.
 */

/** Politeness rung: 0 honest HTTP, 1 real browser, 2 evasive. */
export type Tier = 0 | 1 | 2;

/** What a request is for; selects the route and the budget it spends. */
export type WebPurpose = "fetch" | "probe" | "navigate" | "search";

/** How the runtime classified a response. */
export type Outcome =
  /** Usable content. */
  | "ok"
  /** An empty shell that needs JavaScript to fill in. */
  | "js-shell"
  /** Content arrived but failed the reader quality gate. */
  | "quality-fail"
  /** A CAPTCHA or interstitial that only a human can clear. */
  | "challenge"
  /** A 401/403-style block without challenge markers. */
  | "blocked-hard"
  /** A consent wall that must not be accepted on the caller's behalf. */
  | "consent"
  /** Rate limited or temporarily unavailable, with or without `Retry-After`. */
  | "throttled"
  /** Refused because `robots.txt` disallows the URL under `strict`. */
  | "robots-disallow"
  /** Any other unsuccessful status, such as 404 or 500. */
  | "http-error";

/** Which transport produced the bytes. */
export type WebTransport = "http" | "browser";

/** Whether a request carries the profile's cookie jar. */
export type CookiePolicy = "none" | "profile";

/** How a session relates to the shared browser profile. */
export type IsolationMode = "tabs" | "contexts";

/** What the shared classifier found behind a challenge page. */
export interface ChallengeSummary {
  /** Challenge family, such as `cloudflare`, `anubis`, or `recaptcha`. */
  type: string;
  /** `blocking` when the page is unusable, `present` when a widget is embedded. */
  severity: "blocking" | "present";
  /** Signals that matched, for diagnostics. */
  evidence: string[];
}

/** One request handled by the runtime, whatever transport ends up serving it. */
export interface WebRequest {
  url: string;
  method?: "GET" | "HEAD" | "POST";
  purpose: WebPurpose;
  /** Session that owns the request, for tab ownership and per-session budgets. */
  sessionId: string;
  /**
   * Highest tier this call may reach. Every call still starts at tier 0, so a
   * `robots.txt` refusal is seen before any escalation.
   */
  tier?: Tier;
  /** `profile` sends the warm cookie jar, `none` starts without cookies. */
  cookies?: CookiePolicy;
  /** Extra request headers, such as a probe's `Accept`. */
  headers?: Record<string, string>;
  /** Request body for `POST`. */
  body?: string;
}

/** One classified response. */
export interface WebResult {
  /** Final URL after redirects. */
  url: string;
  status: number;
  outcome: Outcome;
  /** Tier that produced the result. */
  tier: Tier;
  transport: WebTransport;
  contentType?: string;
  headers?: Record<string, string>;
  /** Response body; absent for `HEAD` and for failures with no readable body. */
  body?: string;
  /** True when the body came from the HTTP cache instead of a transfer. */
  cached?: boolean;
  /** True when the body was cut at the configured byte or character cap. */
  truncated?: boolean;
  /** Delay the host asked for, in milliseconds; present on `throttled`. */
  retryAfterMs?: number;
  /** Short machine-readable explanation for a non-`ok` outcome. */
  reason?: string;
  /** Notes worth surfacing to the caller, such as a robots warning. */
  notes?: string[];
  /** Classifier output when `outcome` is `challenge`. */
  challenge?: ChallengeSummary;
}

/** Options for attaching a session to the shared runtime. */
export interface SessionOptions {
  /** `tabs` shares profile cookies; `contexts` keeps its own cookie jar. */
  isolation: IsolationMode;
  /** Upper bound on pages this session may hold open at once. */
  maxPages?: number;
}

/** The two entry points every web tool uses. */
export interface WebRuntime {
  request(request: WebRequest & { signal?: AbortSignal }): Promise<WebResult>;
  openSession(id: string, options: SessionOptions): Promise<SessionHandle>;
}

/**
 * A session's handle on the shared browser. Closing a handle releases that
 * session's tabs and buffers; the browser process and other sessions stay up.
 */
export interface SessionHandle {
  readonly id: string;
  readonly isolation: IsolationMode;
  close(): Promise<void>;
}
