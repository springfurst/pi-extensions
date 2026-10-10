# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the repository's tag-based release policy.

## Unreleased

### Added

- `web_fetch`: read a URL as markdown or text, with site-specific handlers for GitHub, GitLab, npm, PyPI, crates.io, Wikipedia, arXiv, PubMed, RFC, Semantic Scholar, docs.rs, MDN, Hacker News, Reddit, and Stack Exchange; digestible-format discovery; an SSRF-guarded fetch layer; line selectors; and `save_path` for full output.
- `web_fetch`: headless-Chromium rendering as the final reader backend, so JavaScript-gated pages are rendered and re-extracted (method `browser`) when an earlier reader produced nothing usable.
- `web_search`: keyless meta-search across DuckDuckGo, Startpage, and SearXNG, with Google-style query directives, cross-engine aggregation, result caching, and structured output.
- `web_search`: browser-backed Google, Ecosia, and Mojeek engines in the default pool, available automatically when a browser resolves.
- Shared `browser` configuration with automatic Chrome/Chromium/Edge detection, a shared idle-closed browser process, per-render timeouts, a page cap, and `PUPPETEER_EXECUTABLE_PATH` support. The extension never downloads a browser, and the feature is off when none resolves.
- Shared `browser.userDataDir` to reuse a persistent Chromium profile across launches, so cookies and storage warmed by a manually launched browser carry into later renders.
- Configuration through `web-tools.json` in the agent directory and, for trusted projects, the project directory.

### Fixed

- `web_fetch`: apply line selectors and `save_path` to the full rendered body before capping for the model, so tail selectors return the correct lines and saved files are complete; `fetch.maxChars`/`max_chars` now also govern site-handler output instead of a fixed 500,000-character handler cap.
- `web_fetch`: keep the port on a bare `host:port` URL instead of reading it as a line selector; selectors after a path still peel.
- `web_fetch`: bound each call with the documented wall-clock `fetch.timeoutSeconds` deadline; previously it applied per request, so multi-request handlers and digest probes could exceed it.
- `web_fetch`: drop `Authorization`, `Cookie`, and `Proxy-Authorization` when a redirect changes origin, instead of replaying them to the new host.
- `web_fetch`/`web_search`: decode numeric HTML character references (`&#62;`, `&#8217;`, `&#x27;`) consistently, so Hacker News comments and feed text no longer leak entity codes.
- `web_search`: document that a `week` recency window widens to `month` on SearXNG, which only supports day/month/year time ranges.
- `web_search`: report `No results found.` instead of empty output when no engine returns a result, and detect Startpage's Anubis challenge page as an engine failure rather than an empty success.
- `web_fetch`: report the truncation binding that actually cut the output (the model-safe limit takes precedence over the render cap), stop flagging selectors that fit under the cap, and report the `save_path` location in the output.
- `web_search`: carry the source list in `details` so the transcript renderer can show results; pi does not forward `structuredContent` to renderers, so the summary previously always read `0 sources`.
