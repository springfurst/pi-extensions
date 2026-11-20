# web_fetch

## Overview

`web_fetch` reads a URL and returns readable text for the model. It is the tool to reach for when the URL is already known: documentation pages, articles, API responses, feeds, and source files. HTML is rendered to markdown, JSON is pretty-printed, and feeds are converted to markdown. When a JavaScript-gated page defeats the HTTP readers and a browser is installed, `web_fetch` renders it in headless Chromium before falling back to raw HTML.

## Parameters

| Name        | Type    | Required | Description                                                                                                                        |
| ----------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `url`       | string  | yes      | Absolute `http(s)` URL, optionally with a trailing selector.                                                                       |
| `raw`       | boolean | no       | Return the response body verbatim, skipping text shaping.                                                                          |
| `max_chars` | number  | no       | Per-call render cap in characters; overrides `fetch.maxChars`.                                                                     |
| `save_path` | string  | no       | Write the full rendered content to this file (relative paths resolve against the working directory), so long output can be grep'd. |

### URL selectors

A URL may end with a selector that slices the rendered text, mirroring the file reader:

| Selector   | Effect                                |
| ---------- | ------------------------------------- |
| `:N`       | From line `N` to the end.             |
| `:N-M`     | Lines `N` through `M`.                |
| `:N+K`     | `K` lines starting at `N`.            |
| `:A-B,C-D` | Multiple ranges.                      |
| `:-N`      | The last `N` lines.                   |
| `:raw`     | Verbatim body; combine as `:raw:N-M`. |

When a URL would otherwise look like `host:port`, add a trailing slash before the selector, for example `https://example.com/:80`.

## Output

A metadata header followed by the rendered body:

```text
URL: <final url>
Content-Type: <mime>
Method: <reader method>
Notes: <semicolon-joined notes, omitted when empty>

---

<rendered content>
```

`Method` names the stage that produced the content, such as `readability`, `json`, `feed`, `md-suffix`, `github-repo`, `browser`, `raw-html`, or `binary`.

When the body was reshaped — by a site handler, a reader backend, or an alternate representation — or a policy limited the read, the result notes say that `:raw` returns the verbatim response body. A body that is already verbatim, such as JSON, text, raw HTML, or a `:raw` read, carries no such note.

## Configuration

`web_fetch` reads `web-tools.json` from the pi agent directory and, when the project is trusted, from `<cwd>/.pi/`. Values in the project file override the global file; per-call arguments override both.

| Key                                  | Default       | Effect                                                                                  |
| ------------------------------------ | ------------- | --------------------------------------------------------------------------------------- |
| `fetch.maxChars`                     | 500000        | Maximum rendered characters per fetch.                                                  |
| `fetch.timeoutSeconds`               | 30            | Wall-clock fetch deadline.                                                              |
| `fetch.maxBytes`                     | 50 MiB        | Maximum response bytes read.                                                            |
| `fetch.remoteFallbacks`              | `false`       | Enable the Jina remote reader.                                                          |
| `fetch.externalReaders`              | `true`        | Use `trafilatura`/`lynx` when on `PATH`.                                                |
| `fetch.allowPrivateHosts`            | `false`       | Disable the SSRF guard for local hosts.                                                 |
| `politeness.robots`                  | `warn`        | `robots.txt` handling: report and continue, or `strict` to refuse.                      |
| `politeness.userAgent`               | honest        | One descriptive user agent; no per-request rotation.                                    |
| `politeness.contact`                 | unset         | Contact address sent in the `From` header.                                              |
| `politeness.globalConcurrency`       | `4`           | Requests in flight across every host.                                                   |
| `politeness.globalRequestsPerSecond` | `8`           | Requests per second across every host, with a short burst.                              |
| `politeness.latencyWarningFactor`    | `2`           | Latency factor over a host's baseline that raises a warning and widens spacing.         |
| `politeness.maxRetryWaitSeconds`     | `30`          | Longest `Retry-After` the tool waits for; a longer delay fails fast.                    |
| `politeness.tier`                    | `polite`      | Highest rung: `polite` stops at a real browser, `evasive` also allows the evasive tier. |
| `politeness.evasion`                 | `off`         | `on-block` lets a hard block (401/403/451) reach the evasive tier.                      |
| `politeness.human`                   | `hint`        | `hint`, `transparent`, or `disabled` for a detected challenge.                          |
| `hosts.<host>.tier`                  | global        | Per-host tier ceiling; a host entry also covers its subdomains.                         |
| `hosts.<host>.minIntervalMs`         | curated       | Minimum gap between two requests to that host, replacing the curated value.             |
| `hosts.<host>.robots`                | global        | `warn` or `strict` for that host. A host entry also covers its subdomains.              |
| `hosts.<host>.allow`                 | unset         | Blocking categories that host's pages may load despite `blocking`.                      |
| `blocking.<category>`                | `third-party` | `off` or `third-party` for `ads`, `analytics`, `images`, `media`, and `fonts`.          |
| `runtime.profile`                    | `shared`      | Profile for the shared browser; shared with `web_search` and `browser-pilot`.           |
| `runtime.attach`                     | `auto`        | Attach to a live DevTools endpoint instead of failing on a busy profile.                |
| `runtime.maxPages`                   | `6`           | Pages allowed across every session sharing the browser.                                 |
| `runtime.headless`                   | `auto`        | Launch mode when this process opens the browser: `auto`, `true`, or `false`.            |
| `browser.enabled`                    | `true`        | Enable browser rendering when a binary resolves.                                        |
| `browser.executablePath`             | unset         | Pin a specific Chrome/Chromium executable.                                              |
| `browser.userDataDir`                | unset         | Reuse a persistent Chromium profile across launches.                                    |
| `browser.stealth`                    | `false`       | Reserved for future stealth patches.                                                    |
| `browser.noSandbox`                  | `false`       | Add `--no-sandbox` for root/containers.                                                 |
| `browser.timeoutSeconds`             | `20`          | Upper bound on a single browser navigation; a shorter tool deadline still wins.         |
| `browser.idleCloseSeconds`           | `120`         | Close the shared browser after this idle period; `0` disables idle close.               |
| `browser.maxPages`                   | `2`           | Maximum concurrent browser pages.                                                       |
| `browser.allowPrivateHosts`          | `false`       | Permit private hosts in the browser.                                                    |

Secrets stay in the environment: `GITHUB_TOKEN` or `GH_TOKEN`, `NCBI_API_KEY`, and `JINA_API_KEY`. `PUPPETEER_EXECUTABLE_PATH` overrides the browser binary and takes precedence over `browser.executablePath`.

### Browser rendering

Browser rendering activates automatically when a Chrome, Chromium, or Edge binary resolves. Resolution order is `PUPPETEER_EXECUTABLE_PATH`, then `browser.executablePath`, then a detected system browser on `PATH` and the usual install locations. The extension never downloads a browser; when none resolves, browser rendering is silently unavailable and behavior is unchanged.

Renders use the same browser process as `browser-pilot` and `web_search`. The profile is `browser.userDataDir` when set, otherwise `runtime.profile` under `<agentDir>/browser-pilot/profiles/`. `runtime.headless` picks the launch mode when this process opens the browser: `auto` (default) opens a real window when a display exists and renders headless otherwise, `true` always renders headless, and `false` always opens a window. Whoever opens the profile first decides for every tool; a later caller attaches to the live process. Because of that, a fetch that needs the browser can open a visible window when no browser was running. The browser keeps the real binary's identity: `web_fetch` does not override the user agent.

Rendered pages block third-party ads, analytics, images, media, and fonts by default; `blocking.<category>` turns a category off and `hosts.<host>.allow` re-enables one category for pages on that host. Pages are short-lived: one page per render, closed afterward. `browser.maxPages` caps concurrent renders from this tool, `runtime.maxPages` caps pages across every tool sharing the process, and the browser stays warm for `browser.idleCloseSeconds` after the last render. Closing the shared browser is `browser-pilot`'s job; a fetch never closes it while another session is using it.

A dedicated Chrome for Testing build is preferred over a daily-use browser: it keeps a stable Chromium version for `puppeteer-core` and avoids macOS handing a background launch the user's open-URL events. Download a build from the Chrome for Testing page, unpack it, and point `browser.executablePath` (or `PUPPETEER_EXECUTABLE_PATH`) at its executable.

### Persistent browser profile

By default the shared browser uses the `shared` profile at `<agentDir>/browser-pilot/profiles/shared`, so cookies and site storage stay warm across calls and restarts and are the same ones `browser-pilot` uses. `runtime.profile` names a different profile, and `browser.userDataDir` points at a Chromium user data directory of your choosing:

```json
{ "browser": { "userDataDir": "/home/you/.pi/web-tools-profile" } }
```

The path is the user data directory (the parent of `Default`/`Profile N`), not a profile subdirectory. An absolute path is recommended; a relative path resolves against the process working directory and a leading `~` is not expanded. Native absolute paths work on both platforms: `/home/you/profile` on Linux/macOS, and `C:/Users/you/profile` or `C:\\Users\\you\\profile` on Windows. Prefer forward slashes; a Windows path in JSON must double its backslashes, and a config file containing an invalid escape is ignored. The extension keeps the directory between renders and never deletes it.

A profile can be warmed before use: launch the same browser with `--user-data-dir=<path>`, browse normally so cookies and storage are written, then close it. Later renders reuse that state, and a browser the tools started keeps the profile warm while it runs. Chromium allows one instance per profile: the tools attach to a browser they launched, but a browser launched by hand without the tool's instance record makes the render fail with a "browser is already running" error. Use a dedicated directory rather than a daily-use profile, since stored cookies and logins persist on disk and are shared by every browser render.

### Usage logging

`web_fetch` records one JSONL line per call when `logging.enabled` is set. The line carries the tool input (unless `logging.includeArgs` is `false`), the parser that produced the content and its `parserKind`, the HTTP `status`, `contentType`, `finalUrl`, `charCount`, truncation binding, `savedPath`, the pipeline `notes`, `cache` (`hit`, `miss`, or `bypass`), and `limiter` (`waitedMs` and `minIntervalMs`) so pacing and revalidation can be analyzed offline. See the root [README](../../README.md#usage-logging) for the shared config keys and record format.

## Behavior and fallbacks

The pipeline runs site handlers first, then a generic fetch and extraction path. Any handler that fails or does not apply returns control to the generic path, so layout drift never breaks a read.

- **Site handlers** come from a declarative registry. Each entry names the hosts it owns (exact, subdomain, or path-scoped), the parser methods it can emit, the transports it prefers (`api`, `reader`, `browser`), any environment token it can use, and starting gaps for the hosts it contacts. A URL is routed to the one matching entry, so adding a host to an existing parser is a registry entry rather than a change to the pipeline. Handlers produce structured markdown for GitHub, GitLab, npm, PyPI, crates.io, Wikipedia, arXiv, PubMed, RFC, Semantic Scholar, docs.rs, MDN, Hacker News, and Stack Exchange.
- **Digestible formats** are preferred when available: a `<link rel="alternate" type="text/markdown">`, a `.md` URL variant, HTTP content negotiation, and feed alternates.
- **Reader chain**: Readability with Turndown first, then `trafilatura`, then `lynx`, then Jina, then a browser render. Each backend must clear a quality gate before it is accepted. A JavaScript shell or a quality failure first climbs the routing ladder, so the shared browser renders the page before shaping starts and the reader that shapes the rendered DOM is the reported `Method` with a note explaining the escalation; if the reader chain itself reaches the browser, the method is `browser`.
- **Fetch** sends one honest, configurable user agent, follows redirects manually, honors `robots.txt`, paces requests per host and globally, retries a throttled response once within the wait budget, streams the body under a byte cap, and decodes according to the declared charset. One wall-clock deadline (`fetch.timeoutSeconds`) bounds the whole call, including digest probes and handler fan-out.

### Politeness

`web_fetch` identifies itself instead of impersonating a browser: the default user agent is `pi-web-tools/1.0 (+https://github.com/springfurst/pi-extensions)`, and `politeness.userAgent` plus `politeness.contact` replace it when set. A user agent is never rotated to get past a block; a refused request is reported.

Before the first request to an origin, `robots.txt` is read once and cached for an hour. `politeness.robots: "warn"` fetches a disallowed path anyway and notes the rule in the result (`strict` refuses with the rule named). `Crawl-delay` and `Request-rate` set a floor for the host's request spacing.

Requests are paced by three budgets: the per-host gap, a global concurrency cap, and a global requests-per-second bucket. Host gaps start from a curated table, `hosts.<host>.minIntervalMs`, and the starting gaps a site handler declares for the API hosts it contacts; configured values win. Gaps are learned: a `429`, `503`, `Retry-After`, or rate-limit reset multiplies the gap (bounded to four times the base), successes reduce it again, and a sustained latency rise raises it one notch and makes the next block learn faster. Learned values live in `<agentDir>/web-tools/host-state.json` and survive a restart; values untouched for thirty minutes fall back to the curated base.

`Retry-After` is parsed in full, both delay-seconds and HTTP-date. A delay within `politeness.maxRetryWaitSeconds` is waited out and the request retried once. A longer delay fails immediately with the retry time named, so the caller can use a different source instead of stalling.

A blocking CAPTCHA or interstitial is detected before the body is shaped and reported as a challenge with its family (Cloudflare, Anubis, reCAPTCHA, hCaptcha, PerimeterX, DataDome); it is never treated as something another user agent can get past. A CAPTCHA widget embedded in otherwise usable content is not treated as a block.

### Routing and challenges

Every request starts on the honest HTTP tier and climbs only when the outcome calls for it. A JavaScript shell or a failed quality gate may climb to a real browser; a hard 401/403/451 block climbs to the evasive tier only when `politeness.tier` is `evasive` and `politeness.evasion` is `on-block`. A host may escalate at most once per ten minutes, and a per-call ceiling cannot exceed the configured one. A `robots.txt` refusal is never overridden by a higher tier.

A detected challenge is not a routing problem, because escalation cannot clear it. `politeness.human` decides what happens: `hint` (the default) returns the challenge with its family and the page is not shaped, `transparent` waits for a human and retries once the challenge clears, and `disabled` fails cleanly with the reason. A call with no way to reach a human, such as `web_fetch`, reports instead of waiting when `transparent` is configured. A challenge is never sent to the evasive tier. Consent walls are reported and never accepted automatically.

### Caching and alternative representations

Responses that carry an `ETag` or `Last-Modified` are stored under `<agentDir>/web-tools/http/` and revalidated on the next fetch of the same URL and representation. A `304 Not Modified` returns the stored body, so a repeat fetch transfers no body; anything without a validator is fetched in full. Requests that carry a cookie jar, and responses cut at the byte cap, are not stored.

Alternate representations are probed without repeating a candidate within one call: the `/path.md` variant first, then HTTP content negotiation on the original URL, and — only when the reader chain fails or its output is too thin — the scoped `llms.txt`/`llms.md` files. A probe is only accepted when it returns real text (not an HTML shell) above a minimum length, and probes inherit the same pacing and robots handling as the main fetch. When the shared browser is already open, probes also send that profile's cookies, so a logged-in site answers HTTP probes the way it would answer the browser. Compression is negotiated normally, except for origins known to return corrupt compressed bodies, which are asked for an identity encoding.

- **Safety**: only `http` and `https` are allowed, and loopback, private, link-local, and cloud-metadata ranges are rejected unless `fetch.allowPrivateHosts` is set. Redirects are re-checked on every hop, and credential headers (`Authorization`, `Cookie`) are dropped when a redirect changes origin. External readers re-fetch the URL themselves, so they are skipped when the URL fails the guard. The browser re-checks the initial URL, resolves the DNS for every navigation (redirects and scripted navigation included) with the same guard, and aborts non-`http(s)` and private/metadata requests during navigation.

Long output is capped by the lower of `fetch.maxChars`/`max_chars` and pi's model-safe limit. Line selectors and `save_path` run against the full rendered body, and only the text returned to the model is capped: a tail selector reads the true tail, and a saved file is complete. The result names which limit bound it and suggests a selector range or `save_path` for the rest; when `save_path` is set, the saved location is reported. When the rendered document exceeds `fetch.maxChars`, the render cap is reported even if a selector reduced the returned text below it.

## Limitations

- No document conversion (PDF, DOCX, XLSX, PPTX, EPUB), images, archives, SQLite, or notebooks. A binary response is reported with method `binary` and an empty body; add `:raw` to read the bytes verbatim.
- Browser rendering needs an installed Chrome, Chromium, or Edge; without one, JavaScript-rendered pages fall back to raw HTML.
- The browser blocks non-`http(s)` schemes and literal private, loopback, link-local, and metadata hosts, and resolves the DNS for every navigation so a public hostname that redirects or is scripted to a private address is blocked. Subresources are checked literally only, so a public hostname that resolves to a private address in a subresource (an image or script) is not blocked; subresource DNS-rebinding hardening is best-effort.
- Browser launches are slow and memory-heavy. The shared browser is capped by `runtime.maxPages` across tools and by `browser.maxPages` for this tool, and it stays warm until `browser.idleCloseSeconds` passes with no session using it.
- The profile is single-instance. Renders attach to a browser the tools started, but a browser launched by hand without the tool's instance record holds the profile lock; close it before rendering. The profile directory keeps cookies and logins on disk.
- With `runtime.headless: "auto"` and a display, a fetch that needs the browser opens a visible Chrome window. Set `runtime.headless: true` to keep rendering headless; a headless process cannot be handed to a human to clear a CAPTCHA.
- The optional `trafilatura` and `lynx` readers are used only when already installed.
- Public sites may block automated requests, including browser renders; the tool reports the failure rather than retrying indefinitely, and never rotates user agents to get past a block.
- `robots.txt` allows a path by default when the file is missing or unreadable; `politeness.robots: "strict"` refuses a disallowed path but does not check anything else about the site's terms.

## License and provenance

Behavior and code are adapted from `oh-my-pi` (MIT, Stencil Labs). See [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). Original code in this repository is MIT; see [LICENSE](../../LICENSE).
