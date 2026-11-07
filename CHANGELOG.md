# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the repository's tag-based release policy.

## [Unreleased]

### Added

- `browser-pilot`: pilot a visible Chrome window over the DevTools protocol. The tool spawns Chrome with `--remote-debugging-port=0`, reads the actual port from `DevToolsActivePort`, keeps a per-session tab record, and reconnects or relaunches after a closed window or crash. Actions cover navigation, tabs, accessibility snapshots with stable refs, markdown/text/HTML reads, JavaScript evaluation, clicks, typing, key presses, selects, scrolling, hovering, uploads, downloads, waits, assertions, screenshots, PDF export, console and network capture, HAR and trace recording, cookies, storage, viewport/media/network/CPU/geolocation emulation, request interception, batches, and dialogs. Snapshots include open shadow roots and child frames, and refs resolve inside the owning frame. `connect` attaches to an existing Chrome DevTools endpoint without launching or closing that browser. A shared profile keeps cookies warm by default; `session` and named profiles support parallel work. CAPTCHAs are detected and handed to a human with `wait {for:"human"}`. Opt-in JSONL logging records safe parameters and output summaries without typed text, cookie values, route bodies, or eval source.

[Unreleased]: https://github.com/springfurst/pi-extensions/compare/v0.1.1...HEAD

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
