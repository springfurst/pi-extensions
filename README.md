# pi-extensions

A collection of tools and extensions for [pi](https://pi.dev), the coding agent. Everything is packaged as a single pi package, so it installs straight from GitHub and can be reused across machines and projects.

## Install

```sh
pi install git:github.com/springfurst/pi-extensions@v0.1.0
```

The named ref pins the install. Use `--local` to write the declaration to a project's `.pi/settings.json` instead of global settings.

## Tools

| Tool         | Description                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `web_fetch`  | Read a URL as markdown or text, with site-specific handlers, line selectors, and browser rendering for JavaScript pages.    |
| `web_search` | Search keyless web engines — including browser-backed Google, Ecosia, and Mojeek — and return ranked, deduplicated sources. |

Each tool ships its own README under `extensions/<tool>/`, covering parameters, output, configuration, behavior, and limitations.

## Configuration

Both tools read `web-tools.json` from the pi agent directory (`~/.pi/agent/web-tools.json`) and, when the project is trusted, from `<cwd>/.pi/web-tools.json`. Project values override global values. Secrets stay in the environment. The per-tool READMEs list every key.

Both tools share a `browser` section for headless-Chromium rendering. A browser is detected automatically from the system; `browser.enabled: false` turns the feature off and `browser.executablePath` pins a specific binary. `browser.userDataDir` points at a persistent Chromium profile so warmed cookies and storage carry across launches. The extension never downloads a browser: when none resolves, browser rendering is unavailable and the tools behave as before.

## Usage logging

Both tools can append one JSON object per call to a per-tool JSONL file, so call history can be analyzed offline. Logging is opt-in and off by default.

| Key                   | Default                      | Effect                                                                                                       |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `logging.enabled`     | `false`                      | Record completed calls.                                                                                      |
| `logging.dir`         | `<agentDir>/web-tools/usage` | Directory for the JSONL files; `~` expands to the home directory and relative paths resolve against the cwd. |
| `logging.includeArgs` | `true`                       | Record the tool input (URL or query). Set `false` when URLs or queries may carry secrets.                    |

The agent directory is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it. When enabled, `web_fetch` appends to `<logging.dir>/web_fetch.jsonl` and `web_search` to `<logging.dir>/web_search.jsonl`. Files are created with user-only permissions and are append-only; delete a file to reset the history.

Every record shares an envelope: `schema`, `timestamp`, `tool`, `toolVersion`, `piVersion`, `sessionId`, `sessionFile`, `sessionName`, `toolCallId`, `cwd`, `mode`, `durationMs`, `outcome`, and `error`.

A `web_fetch` record adds `requestedUrl`, `finalUrl`, `host`, `contentType`, `status`, `parser` (the pipeline method, such as `readability`, `browser`, `github-repo`, `json`, or `raw-html`), `parserKind` (`site`, `reader`, `format`, `raw`, or `error`), `charCount`, `truncated`, `truncationBinding`, `savedPath`, `selector`, and `notes`.

A `web_search` record adds `provider`, `enginesRequested`, `enginesUsed`, `aggregate`, `cacheHit`, `resultCount`, `relaxedConstraints`, and `perEngine`. Each `perEngine` entry has a `status` (`ok`, `empty`, `error`, `timeout`, `cooldown`, `skipped`, or `cached`), `returned` (the raw count before deduplication), `contributed` (the count of unique results after deduplication), and `durationMs`.

Example queries with `jq`:

```sh
# Which parser resolves a fetch, grouped by kind.
jq -r 'select(.tool=="web_fetch") | .parserKind + " " + .parser' ~/.pi/agent/web-tools/usage/web_fetch.jsonl | sort | uniq -c

# Per-engine search yield: engine, status, returned, contributed.
jq -r 'select(.tool=="web_search") | .perEngine[] | "\(.id) \(.status) \(.returned) \(.contributed)"' ~/.pi/agent/web-tools/usage/web_search.jsonl | sort | uniq -c

# Outcome counts across both tools.
jq -r '.tool + " " + .outcome' ~/.pi/agent/web-tools/usage/*.jsonl | sort | uniq -c
```

## Selecting resources

A package entry in pi's settings can narrow which resources load from this repository, so a machine can opt into just one tool:

```json
{
  "packages": [
    {
      "source": "git:github.com/springfurst/pi-extensions@v0.1.0",
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
