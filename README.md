# pi-extensions

A collection of tools and extensions for [pi](https://pi.dev), the coding agent. Everything is packaged as a single pi package, so it installs straight from GitHub and can be reused across machines and projects.

## Install

```sh
pi install git:github.com/springfurst/pi-extensions@v0.4.0
```

The named ref pins the install. Use `--local` to write the declaration to a project's `.pi/settings.json` instead of global settings.

## Tools

| Tool            | Description                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_fetch`     | Read a URL as markdown or text, with site-specific handlers, line selectors, and browser rendering for JavaScript pages.                          |
| `web_search`    | Search keyless web engines — including browser-backed Google, Ecosia, and Mojeek — and return ranked, deduplicated sources.                       |
| `browser-pilot` | Browse the web in a real Chrome window: read pages, inspect and interact with them, run JavaScript, record traffic, and hand CAPTCHAs to a human. |

Each tool ships its own README under `extensions/<tool>/`, covering parameters, output, configuration, behavior, and limitations.

## Configuration

`web_fetch` and `web_search` read `web-tools.json` from the pi agent directory (`~/.pi/agent/web-tools.json`) and, when the project is trusted, from `<cwd>/.pi/web-tools.json`. Project values override global values. Secrets stay in the environment. The per-tool READMEs list every key.

All three web tools render through one shared browser process per profile. `browser-pilot`'s `shared` profile lives at `~/.pi/agent/browser-pilot/profiles/shared`; `web_fetch` and `web_search` lease the same process instead of launching their own headless Chromium, so cookies, logins, challenge state, and the browser identity are the same everywhere. A render from either web tool opens a short-lived page in that browser and closes it when the page is done; the browser itself stays warm for `browser.idleCloseSeconds`. `web_fetch`/`web_search` select the binary and profile with the `browser` section (`enabled`, `executablePath`, `userDataDir`) and the shared `runtime` section (`profile`, `attach`, `maxPages`, `headless`). `browser.userDataDir` takes precedence over `runtime.profile`. `runtime.headless` chooses the launch mode when this process opens the browser: `auto` (the default) uses a real window when a display exists, `true` renders headless, and whoever opens the profile first decides. The tools never download a browser: when none resolves, browser rendering is unavailable and they behave as before.

`browser-pilot` reads `browser-pilot.json` from the agent directory (`~/.pi/agent/browser-pilot.json`) and, when the project is trusted, from `<cwd>/.pi/browser-pilot.json`. It spawns a Chrome process with `--remote-debugging-port=0`, keeps a profile at `~/.pi/agent/browser-pilot/profiles/`, and exposes navigation, snapshots, interaction, uploads and downloads, PDF/HAR/trace export, cookies, storage, emulation, request interception, assertions, batches, console and network capture, and CAPTCHA handoff. It can also attach to an existing DevTools endpoint. The default `shared` profile keeps cookies and logins warm: one Chrome process serves a profile, sessions in one pi process lease it, and a second pi process attaches to the live DevTools endpoint instead of failing on the profile lock. `runtime.isolation: "contexts"` gives a session its own cookie jar instead of the shared one; `profile:"session"` or a named profile keeps unrelated work apart. `browser-pilot` never downloads a browser. See [extensions/browser-pilot/README.md](extensions/browser-pilot/README.md) for every key and action.

## Politeness and host limits

The web tools identify themselves, pace their requests, and stop when a site says no. The settings live in the shared `politeness` and `hosts` blocks of `web-tools.json` and `browser-pilot.json`; the per-tool READMEs list every key.

- **One honest identity on HTTP.** `web_fetch` sends the configured user agent (`politeness.userAgent`, default `pi-web-tools/1.0 (+https://github.com/springfurst/pi-extensions)`) with an optional `From` contact, and never rotates identities to get past a block. Browser-backed search engines present one internally consistent browser fingerprint instead, because those engines reject non-browser clients.
- **`robots.txt`.** Parsed, cached per origin for an hour, and honored. `politeness.robots: "warn"` fetches a disallowed path and notes the rule; `strict` refuses with the rule named. `Crawl-delay` and `Request-rate` become spacing floors.
- **Pacing.** Requests, browser navigations, and search fan-out share a per-host gap plus global concurrency and requests-per-second budgets. Gaps start from a curated table, `hosts.<host>.minIntervalMs`, and the starting gaps site handlers declare for their APIs; they learn from `429`, `503`, `Retry-After`, and rate-limit resets within a bounded range, decay on success, and persist in `<agentDir>/web-tools/host-state.json`.
- **Retry-After.** Parsed in full, as delay-seconds or an HTTP-date. A delay within `politeness.maxRetryWaitSeconds` is waited out and retried once; a longer delay fails fast and names the retry time.
- **Tiers.** Every request starts on the honest HTTP tier. A JavaScript shell or a failed quality gate may climb to the real browser; a hard block climbs to the evasive tier only when `politeness.tier: "evasive"` and `politeness.evasion: "on-block"` are configured. A host escalates at most once per ten minutes, and `robots.txt: "strict"` is never overridden.
- **Challenges.** A blocking CAPTCHA or interstitial routes to the configured human mode instead of the evasive tier: `hint` (default) reports it with its family, `transparent` waits for a human, `disabled` fails cleanly. `browser-pilot` hands the window to a human with `{action:"wait", params:{until:"human"}}`.
- **Subresource blocking.** Third-party ads, analytics, telemetry, images, media, and fonts are blocked in browser renders. First-party requests are untouched; `blocking.<category>` turns a category off and `hosts.<host>.allow` re-enables one for a host.

## Usage logging

All tools can append one JSON object per call to a per-tool JSONL file, so call history can be analyzed offline. Logging is opt-in and off by default.

| Key                   | Default                      | Effect                                                                                                       |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `logging.enabled`     | `false`                      | Record completed calls.                                                                                      |
| `logging.dir`         | `<agentDir>/web-tools/usage` | Directory for the JSONL files; `~` expands to the home directory and relative paths resolve against the cwd. |
| `logging.includeArgs` | `true`                       | Record the tool input (URL or query). Set `false` when URLs or queries may carry secrets.                    |

The agent directory is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it. When enabled, `web_fetch` appends to `<logging.dir>/web_fetch.jsonl` and `web_search` to `<logging.dir>/web_search.jsonl`. Files are created with user-only permissions and are append-only; delete a file to reset the history.

`browser-pilot` uses the same `logging` section in `browser-pilot.json`, with its own default directory (`<agentDir>/browser-pilot/logs`) and file (`browser-pilot.jsonl`). It adds `logging.outputs` (`none`, `summary`, `snippet`, or `full`; default `summary`), `logging.maxOutputChars` (default `2000`), and `logging.includeSensitiveArgs` (default `false`). Typed text, `eval` source, cookie and storage values, route bodies, assertion values, and page content are reduced to length and hash unless sensitive arguments are explicitly enabled. When `logging.includeArgs` is false, URLs, titles, challenge data, saved paths, and output text are omitted. Screenshots and exports record the path and metadata, not the file contents.

Every record shares an envelope: `schema`, `timestamp`, `tool`, `toolVersion`, `piVersion`, `sessionId`, `sessionFile`, `sessionName`, `toolCallId`, `cwd`, `mode`, `durationMs`, `outcome`, and `error`.

A `web_fetch` record adds `requestedUrl`, `finalUrl`, `host`, `contentType`, `status`, `parser` (the pipeline method, such as `readability`, `browser`, `github-repo`, `json`, or `raw-html`), `parserKind` (`site`, `reader`, `format`, `raw`, or `error`), `charCount`, `truncated`, `truncationBinding`, `savedPath`, `selector`, `notes`, `cache` (`hit`, `miss`, or `bypass`), and `limiter` (`waitedMs` and `minIntervalMs`).

A `web_search` record adds `provider`, `enginesRequested`, `enginesUsed`, `aggregate`, `cacheHit`, `resultCount`, `relaxedConstraints`, and `perEngine`. Each `perEngine` entry has a `status` (`ok`, `empty`, `error`, `timeout`, `cooldown`, `skipped`, or `cached`), `returned` (the raw count before deduplication), `contributed` (the count of unique results after deduplication), and `durationMs`.

A `browser-pilot` record adds `action`, `profile`, `pid`, `port`, `chromeVersion`, `headless`, `tabCount`, `tab`, `url`, `title`, `status`, `challenge`, `truncated`, `savedPath`, `params`, and `output`. Safe parameters are recorded; typed text, `eval` source, cookie and storage values, and route bodies are represented by length and SHA-256 hash unless `logging.includeSensitiveArgs` is enabled.

Example queries with `jq`:

```sh
# Which parser resolves a fetch, grouped by kind.
jq -r 'select(.tool=="web_fetch") | .parserKind + " " + .parser' ~/.pi/agent/web-tools/usage/web_fetch.jsonl | sort | uniq -c

# Per-engine search yield: engine, status, returned, contributed.
jq -r 'select(.tool=="web_search") | .perEngine[] | "\(.id) \(.status) \(.returned) \(.contributed)"' ~/.pi/agent/web-tools/usage/web_search.jsonl | sort | uniq -c

# Outcome counts across both web tools.
jq -r '.tool + " " + .outcome' ~/.pi/agent/web-tools/usage/*.jsonl | sort | uniq -c

# browser-pilot actions by outcome.
jq -r 'select(.tool=="browser-pilot") | .action + " " + .outcome' ~/.pi/agent/browser-pilot/logs/browser-pilot.jsonl | sort | uniq -c
```

## Selecting resources

A package entry in pi's settings can narrow which resources load from this repository, so a machine can opt into just one tool:

```json
{
  "packages": [
    {
      "source": "git:github.com/springfurst/pi-extensions@v0.4.0",
      "extensions": ["extensions/<tool>/**"]
    }
  ]
}
```

`pi config` offers the same selection interactively. See pi's package documentation for the filter syntax.

## Development

```sh
npm install
npm run format     # Prettier, writes
npm run lint       # ESLint + markdownlint
npm run typecheck  # tsc --noEmit
npm run test       # Vitest, offline/local server only
npm run test:live  # Vitest, live-network checks (opt-in)
```

Run `format`, `lint`, `typecheck`, and `test` before committing (skip checks that have nothing to apply to yet). Extensions are plain TypeScript loaded by pi's module loader; there is no build step. Commits use conventional commit style.

## License

MIT; see [LICENSE](LICENSE). Code derived from other projects keeps its original license and is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
