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
