# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the repository's tag-based release policy.

## Unreleased

### Added

- `web_fetch`: read a URL as markdown or text, with site-specific handlers for GitHub, GitLab, npm, PyPI, crates.io, Wikipedia, arXiv, PubMed, RFC, Semantic Scholar, docs.rs, MDN, Hacker News, Reddit, and Stack Exchange; digestible-format discovery; an SSRF-guarded fetch layer; line selectors; and `save_path` for full output.
- `web_search`: keyless meta-search across DuckDuckGo, Startpage, and SearXNG, with Google-style query directives, cross-engine aggregation, result caching, and structured output.
- Configuration through `web-tools.json` in the agent directory and, for trusted projects, the project directory.

### Fixed

- `web_fetch`: apply line selectors and `save_path` to the full rendered body before capping for the model, so tail selectors return the correct lines and saved files are complete; `fetch.maxChars`/`max_chars` now also govern site-handler output instead of a fixed 500,000-character handler cap.
- `web_search`: report `No results found.` instead of empty output when no engine returns a result, and detect Startpage's Anubis challenge page as an engine failure rather than an empty success.
- `web_fetch`: report the truncation binding that actually cut the output (the model-safe limit takes precedence over the render cap), stop flagging selectors that fit under the cap, and report the `save_path` location in the output.
- `web_fetch`: retry a 403 across the rotated user agents; fix GitLab repository output (missing issue count and raw README); preserve Markdown in GitLab issue and merge-request descriptions; render RFC author names and status/source metadata; stop duplicating Hacker News comments and Wikipedia/MDN lead text; and resolve MDN's absolute page URL.
