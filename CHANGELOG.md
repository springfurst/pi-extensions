# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the repository's tag-based release policy.

## [Unreleased]

### Fixed

- `web_fetch`: a challenge is reported only when the page is actually blocked. CAPTCHA markers that appear alongside usable content, including prose mentions of ReCAPTCHA or hCaptcha, no longer fail the read; provider shells remain blocking.
- `web_fetch`: usage records now carry the transport's `cache` and `limiter` facts on every shaped response, and a binary body is reported as method `binary` instead of being returned as garbled text.
- `web_fetch`: `:raw` now works at a bare host (`https://example.com:raw`) and with a range before raw (`https://example.com:raw:1-2`).
- `web_search`: browser-backed engines are not started while an HTTP engine has results, so a successful HTTP search no longer opens browser pages. They start when the HTTP engines fail or miss the soft deadline.
- `web_search`: the browser-contribution note is added only when a browser engine actually contributed a unique result, and a cache hit reports the engines that ran instead of every configured engine.
- `browser-pilot`: `expect` accepts boolean and numeric `expected` values, `emulate {reset:true}` clears network conditions before a viewport reload, a bad `connect` endpoint reports the underlying message, and `about:blank` is allowed as the internal blank page.
- `browser-pilot`: closing a browser whose external process already exited removes its stale instance record.
- The runtime no longer writes its routing plan to stdout, so tool output and test output stay clean.

### Changed

- `web_fetch`: requests no longer rotate through `curl`, bot, and browser user agents. One honest, configurable user agent is sent (`politeness.userAgent`, default `pi-web-tools/1.0 (+https://github.com/springfurst/pi-extensions)`), with an optional `From` contact (`politeness.contact`). A blocked response is reported instead of retried with a different identity.
- `web_fetch`: `Retry-After` is parsed in full, as delay-seconds or an HTTP-date, and no longer clamped to ten seconds. A delay within `politeness.maxRetryWaitSeconds` (default 30) is waited out and retried once; a longer delay fails immediately and names the retry time.
- `web_fetch`: a CAPTCHA or interstitial is reported as a challenge with its family rather than treated as a retryable bot block.
- `browser-pilot`: the browser no longer overrides its user agent by default. The real binary's identity is kept, and a configured `userAgent` is sent with client hints derived from the same Chrome version.
- `web_search`: page requests for the browser-backed engines no longer hardcode a macOS Chrome identity. The user agent and every `Sec-CH-UA*` hint come from one fingerprint, and the platform matches the host.
- `browser-pilot`: sessions in one pi process share one browser per profile instead of each spawning a process, and a second pi process attaches to the live DevTools endpoint instead of failing on the profile lock. `runtime.isolation: "contexts"` gives a session its own cookie jar.
- `web_fetch`: browser renders no longer launch a private headless Chromium or set a fixed Chrome user agent. They use the shared browser and its real identity, apply the configured `blocking` and `hosts.<host>.allow` policy, and are capped by `browser.maxPages` per tool and `runtime.maxPages` per process.
- `web_fetch`: every request starts on the honest HTTP tier and climbs only when an outcome calls for it. A JavaScript shell or failed quality gate may use the real browser; a hard block reaches the evasive tier only with `politeness.tier: "evasive"` and `politeness.evasion: "on-block"`. A CAPTCHA routes to the human mode (`hint`, `transparent`, or `disabled`) and never to the evasive tier; `robots.txt: "strict"` is never overridden.
- `web_search`: engine failures use the shared challenge classifier, carry `Retry-After`, and put an engine on a 2/5/15-minute cooldown that resets after a success.

### Added

- `web_fetch`: `robots.txt` is parsed, cached per origin for an hour, and honored. `politeness.robots` defaults to `warn`, which notes a disallowed rule and continues; `strict` refuses with the rule named. `Crawl-delay` and `Request-rate` become per-host spacing floors, and `hosts.<host>.robots` overrides the mode for one host.
- `web_fetch`: requests are paced by a per-host gap plus global concurrency and requests-per-second budgets (`politeness.globalConcurrency`, `politeness.globalRequestsPerSecond`). Host gaps start from a curated table and `hosts.<host>.minIntervalMs`, learn from `429`/`503`/`Retry-After`/rate-limit resets within a bounded range, decay on success, and persist to `<agentDir>/web-tools/host-state.json`.
- `web_fetch`: a sustained latency rise over a host's baseline raises a warning, widens that host's spacing one notch, and makes the next block learn faster (`politeness.latencyWarningFactor`).
- `web_fetch`: responses with an `ETag` or `Last-Modified` are cached under `<agentDir>/web-tools/http/` and revalidated on the next fetch, so an unchanged page transfers no body. Requests carrying cookies and bodies cut at the byte cap are not stored.
- `web_fetch`: alternate representations (`.md` variant, content negotiation, scoped `llms.txt`) share one probe chain, never repeat a candidate within a call, and inherit the configured cookie source; compression is negotiated per origin instead of being disabled everywhere.
- `web_fetch`: usage records include `cache` (`hit`, `miss`, or `bypass`) and `limiter` (`waitedMs` and `minIntervalMs`).
- `web_fetch`: site handling is declared in a registry. Each entry names the hosts it owns (exact, subdomain, or path-scoped), the parser methods it can emit, the transports it prefers, the environment tokens it can use, and starting gaps for the API hosts it contacts. Routing uses the registry, and usage records classify parser methods from the same declaration.
- `web_fetch`: when a site handler, a reader backend, or an alternate representation reshapes the body, or a policy limits the read, the result notes say that `:raw` returns the verbatim response body.
- `web_fetch` and `web_search`: browser renders started by these tools apply `blocking.<category>` and the per-host `hosts.<host>.allow` opt-out instead of a fixed third-party policy.
- `web_fetch`, `web_search`, and `browser-pilot`: one browser process serves a profile. The two web tools lease the browser `browser-pilot` uses instead of launching a separate headless Chromium, so cookies, logins, challenge state, and identity are shared. Renditions open short-lived pages that count toward `runtime.maxPages` but not toward the tab-per-minute windows.
- `runtime.headless`: launch mode for a browser this process opens (`auto`, `true`, or `false`). `auto` opens a real window when a display exists, so a fetch or search that needs a browser may open one; `true` keeps it headless and loses the human handoff.
- `web_search`: HTTP engine requests spend the shared per-host and global pacing budgets, and their failures feed the same learned host state as fetch requests.
- `web_fetch`: probes send the warm browser profile's cookies when the shared browser is already open, so HTTP representations of a logged-in site keep the same identity.

### Removed

- `web_fetch`: the Reddit JSON handler is removed. Reddit's public `.json` endpoints answer `403` to non-browser clients, so every Reddit URL paid an extra request before falling back to the generic path. Reddit URLs now go straight to the generic fetch and reader chain.

## [0.4.0] - 2026-11-15

### Changed

- `browser-pilot`: the terminal view shows every call argument in a compact form, even when collapsed, and expanding a call reveals the full arguments. Expanded results show the full returned body under an `Output` heading instead of stopping at 24 lines. JavaScript expressions, structured arguments, eval results, HTML reads, Markdown reads, snapshots, network requests, console messages, steps, tabs, and help output use syntax highlighting or semantic colors. Expanded errors include the full message, arguments, and details.

[0.4.0]: https://github.com/springfurst/pi-extensions/releases/tag/v0.4.0

## [0.3.0] - 2026-11-15

### Changed

- `browser-pilot`: the tool input is now `action` plus an optional `params` object. This is a breaking change: action-specific fields such as `url`, `ref`, and `operation` must be inside `params`. The schema exposes two top-level fields instead of the full parameter list.
- `browser-pilot`: help is group-first. `{action:"help"}` lists topic groups, `{action:"help", params:{group:"inspect"}}` lists a group's actions, and `{action:"help", params:{action:"snapshot"}}` shows one action's parameters and examples. Action help now includes when to use the action and all examples.
- `browser-pilot`: renamed ambiguous parameters: `op` to `operation`, `for` to `until`, `amount` to `pixels`, `detail` to `stack_traces`, `inline` to `inline_image`, `area` to `storage_area`, network `id` to `request_id`, route `id` to `rule_id`, and route response fields now use `response_status`, `response_body`, `response_content_type`, and `response_headers`.
- `browser-pilot`: the tool description and prompt guidelines lead with simple browsing, then point to the group and action help path.

### Added

- `browser-pilot`: results that can contain page-derived text end with a reminder to treat page text as untrusted data, not instructions.

[0.3.0]: https://github.com/springfurst/pi-extensions/releases/tag/v0.3.0

## [0.2.2] - 2026-11-07

### Added

- `browser-pilot`: local files can be opened with `open`, `navigate`, and `tabs new`. The feature is off by default; `allowLocalFiles` enables it and `localFileGlobs` lists the files that may be opened. A bare path such as `./fixtures/page.html` resolves against the working directory and is rewritten to a `file:` URL, and a `file:` URL is accepted directly. Relative globs only match paths inside the working directory, absolute globs match absolute paths, and a path outside the globs is rejected with the reason before Chrome navigates.

[0.2.2]: https://github.com/springfurst/pi-extensions/releases/tag/v0.2.2

## [0.2.1] - 2026-11-07

### Added

- `browser-pilot`: results describe what an action touched and produced. Details carry `subject`, the targeted element named the way snapshots name it, and `preview`, the typed text, evaluated script, read content, selected options, pressed keys, or awaited condition. The terminal view shows both, the call line names the arguments that identify a call, and the first body line stands in when neither is set. Expanded results drop the repeated header and summary line. URLs in headers, tab lists, and the terminal view shorten to the origin and the start of the path, collapsing long queries and fragments to `?…` and `#…`. `console` and `network` accept `list` as an alias for `read`.

### Fixed

- `browser-pilot`: `press` splits `Control+A`-style combinations into held modifiers and a base key instead of passing the whole string to the keyboard, which rejected every combination with "Unknown key". Alternate modifier spellings are accepted, and unknown modifiers or keys report a hint.
- `browser-pilot`: `select` falls back to option labels and visible text when a requested value matches no option, so selecting by label no longer silently selects nothing. Unmatched requests are reported, and a call where nothing matches fails with the available options.
- `browser-pilot`: `clipboard` brings the tab forward and enables focus emulation, so reads and writes no longer fail with "Document is not focused" while the Chrome window is in the background.
- `browser-pilot`: `navigate {direction:"back"}` and `{direction:"forward"}` report a missing history entry only when the URL did not change, instead of on every same-document history move.

[0.2.1]: https://github.com/springfurst/pi-extensions/releases/tag/v0.2.1

## [0.2.0] - 2026-11-07

### Added

- `browser-pilot`: pilot a visible Chrome window over the DevTools protocol. The tool spawns Chrome with `--remote-debugging-port=0`, reads the actual port from `DevToolsActivePort`, keeps a per-session tab record, and reconnects or relaunches after a closed window or crash. Actions cover navigation, tabs, accessibility snapshots with stable refs, markdown/text/HTML reads, JavaScript evaluation, clicks, typing, key presses, selects, scrolling, hovering, uploads, downloads, waits, assertions, screenshots, PDF export, console and network capture, HAR and trace recording, cookies, storage, viewport/media/network/CPU/geolocation emulation, request interception, batches, and dialogs. Snapshots include open shadow roots and child frames, and refs resolve inside the owning frame. `connect` attaches to an existing Chrome DevTools endpoint without launching or closing that browser. A shared profile keeps cookies warm by default; `session` and named profiles support parallel work. CAPTCHAs are detected and handed to a human with `wait {for:"human"}`. Opt-in JSONL logging records safe parameters and output summaries; typed text, eval source, cookie and storage values, route bodies, assertion values, page content, and network or console output are reduced to lengths and hashes unless sensitive arguments are explicitly enabled.
- `browser-pilot`: follow-up capabilities add `doctor`, frame selection and frame-scoped reads, `metrics`, clipboard access, element highlighting, annotated screenshots, permission overrides, and auth-state export/import. `snapshot` now honors `selector`, and `read`, `screenshot`, and selector waits accept refs. `network` returns a compact overview with stable request ids; `network {op:"get", id}` reads headers and body previews on demand, and `wait {for:"response"}` returns the matching request id. `read {format:"outline"}` returns a compact structural tree, `steps` collapses repeated page headers, and `console` collapses repeated messages.

### Fixed

- `browser-pilot`: usage logging now omits URLs, titles, challenge data, saved paths, and output text when `logging.includeArgs` is false, and never logs cookie, storage, or clipboard output. Page-derived output for reads, evaluation, snapshots, console, network, assertions, and batches requires `logging.includeSensitiveArgs`.
- `browser-pilot`: auth-state import validates the bundle, accepts only `http(s)` origins, and applies the navigation guard before touching an origin.
- `browser-pilot`: metadata-host blocking now normalizes alternate IPv4 spellings and IPv4-mapped IPv6 forms; the remaining top-level-only guard limitation is documented.
- `browser-pilot`: `duration_ms` is part of the tool schema, `eval` requires exactly one source, `expect {check:"attribute"}` requires `attribute`, and nested `steps` are validated against the same closed parameter sets as top-level calls.
- `browser-pilot`: `expect {check:"hidden"}` treats missing elements as hidden, and all locator-backed assertions honor `timeout_ms`.
- `browser-pilot`: `tabOverflow:"reuse-blank"` navigates a reused blank tab to the requested URL, read-only actions refresh tab idle state, refs are scoped to their tab, popups respect `maxTabs`, and `noopener` popups are attached.
- `browser-pilot`: `connect` no longer changes the viewport, user agent, emulation, or download behavior of existing external tabs; download capture is limited to launched browsers.
- `browser-pilot`: network overviews record response sizes and timing outside HAR capture, `network {op:"get"}` reports timing phases, download waits resolve the file Chrome actually wrote, and route ids use an `rt` prefix to avoid colliding with request ids.
- `browser-pilot`: `har {op:"stop"}` requires an active recording, a second `har {op:"start"}` is rejected, trace capture warns when `tracingComplete` does not arrive, and HAR entries carry `pageref` and request content types.
- `browser-pilot`: `doctor` verifies configured browser binaries exist, checks logs and profile directories, and explicit executable paths take precedence over environment defaults.

[0.2.0]: https://github.com/springfurst/pi-extensions/releases/tag/v0.2.0

## [0.1.1] - 2026-10-11

### Changed

- `web_search`: the SearXNG bearer token fallback is now read from `SEARXNG_SECRET` instead of `SEARXNG_TOKEN`. The config key `searxng.token` is unchanged.

[0.1.1]: https://github.com/springfurst/pi-extensions/releases/tag/v0.1.1

## [0.1.0] - 2026-10-10

Initial release: two pi tools, `web_fetch` and `web_search`, packaged as one pi package.

### Added

- `web_fetch`: read a URL as markdown or text. Site-specific handlers cover GitHub, GitLab, npm, PyPI, crates.io, Wikipedia, arXiv, PubMed, RFC, Semantic Scholar, docs.rs, MDN, Hacker News, Reddit, and Stack Exchange, with Readability plus optional `trafilatura`, `lynx`, and Jina fallbacks. The tool discovers digestible formats (`.md` suffixes, `llms.txt`, content negotiation, alternate links, and feeds), follows redirects behind an SSRF guard, supports `:N`, `:N-M`, `:N+M`, `:A-B,C-D`, `:-N`, and `:raw` line selectors, and writes the full rendered body with `save_path`. Truncation names the limit that bound the output and offers a selector continuation.
- `web_search`: run a keyless meta-search across DuckDuckGo, Startpage, and SearXNG, plus browser-backed Google, Ecosia, and Mojeek when a browser resolves. It understands Google-style query directives, aggregates results across engines by consensus with URL deduplication, caches responses per process, and returns ranked sources as text and structured output.
- Shared headless-Chromium rendering: automatic Chrome/Chromium/Edge detection, `PUPPETEER_EXECUTABLE_PATH` and `browser.executablePath` overrides, a shared idle-closed browser process, a page cap, per-render timeouts, and optional stealth and `--no-sandbox` modes. `browser.userDataDir` reuses a persistent profile so warmed cookies and storage carry across launches. The extension never downloads a browser, and browser features are unavailable when no browser resolves.
- Shared configuration through `web-tools.json` in the pi agent directory and, for trusted projects, the project directory, with project values overriding global values and per-call arguments overriding both.
- Optional usage logging for both tools (`logging.enabled`): one JSONL record per call under the agent directory, carrying the tool input, parser resolution for `web_fetch`, per-engine result counts for `web_search`, and session and version metadata. `logging.dir` changes the directory and `logging.includeArgs: false` omits URLs and queries.

[0.1.0]: https://github.com/springfurst/pi-extensions/releases/tag/v0.1.0
