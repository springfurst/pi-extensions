# web_search

## Overview

`web_search` searches the web through keyless engines and returns a ranked source list. Use it to discover URLs, then read them with [`web_fetch`](../web_fetch/README.md). Provider selection is internal: no API key is required. DuckDuckGo, Startpage, and SearXNG answer over plain HTTP; Google, Ecosia, and Mojeek are rendered in a headless browser when one is available.

## Parameters

| Name      | Type   | Required | Description                                         |
| --------- | ------ | -------- | --------------------------------------------------- |
| `query`   | string | yes      | Search query; supports the directives listed below. |
| `recency` | string | no       | Time window: `day`, `week`, `month`, or `year`.     |
| `limit`   | number | no       | Maximum results; overrides `search.limit`.          |

SearXNG only supports `day`, `month`, and `year` time ranges, so a `week` request through SearXNG widens to `month`.

### Query directives

`site:`, `-site:`, `after:`/`before:` (`YYYY-MM-DD`), `inurl:`, `intitle:`, `filetype:`, `"quoted phrases"`, `-exclusions`, and `OR` groups. Directives an engine cannot parse are enforced with a lenient post-filter: a constraint that would remove every result is relaxed and reported rather than returning nothing.

## Output

A source list, preceded by any relaxed-constraint notes:

```text
Note: no results matched `site:example.invalid`; the constraint was relaxed
[1] Example result (2d ago)
    https://example.com/one
    Snippet text
[2] Another result
    https://example.com/two
```

The result also carries a structured `{ title, url, snippet }[]` for codemode callers. When no engine returns a result, the body reads `No results found.`

## Configuration

`web_search` reads `web-tools.json` from the pi agent directory and, when the project is trusted, from `<cwd>/.pi/`.

| Key                         | Default                                                           | Effect                                                                            |
| --------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `search.engines`            | `["duckduckgo","startpage","searxng","google","ecosia","mojeek"]` | Active engines, in order.                                                         |
| `search.aggregate`          | `true`                                                            | Merge results across engines.                                                     |
| `search.limit`              | 10                                                                | Default result count.                                                             |
| `search.timeoutSeconds`     | 60                                                                | Per-engine transport deadline.                                                    |
| `search.cacheTtlSeconds`    | 300                                                               | Result cache time-to-live.                                                        |
| `search.provider`           | unset                                                             | Explicit engine override.                                                         |
| `searxng.endpoint`          | unset                                                             | SearXNG base URL.                                                                 |
| `searxng.token`             | unset                                                             | SearXNG bearer token.                                                             |
| `searxng.basicUsername`     | unset                                                             | SearXNG basic-auth username.                                                      |
| `searxng.basicPassword`     | unset                                                             | SearXNG basic-auth password.                                                      |
| `searxng.categories`        | unset                                                             | SearXNG categories filter.                                                        |
| `searxng.engines`           | unset                                                             | SearXNG engine names or shortcuts.                                                |
| `searxng.language`          | unset                                                             | SearXNG language code.                                                            |
| `searxng.safesearch`        | unset                                                             | SearXNG safesearch level (`0`, `1`, or `2`).                                      |
| `runtime.profile`           | `shared`                                                          | Profile for the shared browser; shared with `web_fetch` and `browser-pilot`.      |
| `runtime.attach`            | `auto`                                                            | Attach to a live DevTools endpoint instead of failing on a busy profile.          |
| `runtime.maxPages`          | `6`                                                               | Pages allowed across every session sharing the browser.                           |
| `runtime.headless`          | `auto`                                                            | Launch mode when this process opens the browser: `auto`, `true`, or `false`.      |
| `browser.enabled`           | `true`                                                            | Enable browser rendering when a binary resolves.                                  |
| `browser.executablePath`    | unset                                                             | Pin a specific Chrome/Chromium executable.                                        |
| `browser.userDataDir`       | unset                                                             | Reuse a persistent Chromium profile across launches.                              |
| `browser.stealth`           | `false`                                                           | Reserved for future stealth patches.                                              |
| `browser.noSandbox`         | `false`                                                           | Add `--no-sandbox` for root/containers.                                           |
| `browser.timeoutSeconds`    | `20`                                                              | Upper bound on a single browser navigation; a shorter engine deadline still wins. |
| `browser.idleCloseSeconds`  | `120`                                                             | Close the shared browser after this idle period; `0` disables idle close.         |
| `browser.maxPages`          | `2`                                                               | Maximum concurrent browser pages.                                                 |
| `browser.allowPrivateHosts` | `false`                                                           | Permit private hosts in the browser.                                              |
| `blocking.<category>`       | `third-party`                                                     | `off` or `third-party` for `ads`, `analytics`, `images`, `media`, and `fonts`.    |
| `hosts.<host>.allow`        | unset                                                             | Blocking categories that host's pages may load despite `blocking`.                |

Secrets and the SearXNG connection may also come from `SEARXNG_ENDPOINT`, `SEARXNG_SECRET`, `SEARXNG_BASIC_USERNAME`, and `SEARXNG_BASIC_PASSWORD`; file values win. `PUPPETEER_EXECUTABLE_PATH` overrides the browser binary and takes precedence over `browser.executablePath`. A dedicated Chrome for Testing build is preferred over a daily-use browser for a stable Chromium version and to avoid macOS handing a background launch the user's open-URL events; point `browser.executablePath` at an installed build. The extension never downloads a browser.

### Usage logging

`web_search` records one JSONL line per call when `logging.enabled` is set. The line carries the tool input (unless `logging.includeArgs` is `false`), the winning `provider`, the requested and used engines, `cacheHit`, `resultCount`, relaxed constraints, and a `perEngine` entry for each engine with its status, raw `returned` count, unique `contributed` count, and `durationMs`. See the root [README](../../README.md#usage-logging) for the shared config keys and record format.

## Behavior and fallbacks

- **Engines**: DuckDuckGo's no-JS HTML endpoint, Startpage's homepage-token form flow (a CAPTCHA or Anubis proof-of-work shell is an engine failure), and a user-configured SearXNG instance. SearXNG is skipped when no endpoint is set. Google, Ecosia, and Mojeek are browser-backed and join the pool only when a browser resolves; a challenge is reported as an engine failure and triggers the same cooldown.
- **Pacing**: every engine request spends the shared per-host gap and the global concurrency and requests-per-second budgets, whether it is an HTTP form post or a browser navigation. Browser-backed engines render in the same process `web_fetch` and `browser-pilot` use, so cookies and challenge state are shared; the profile is `browser.userDataDir` when set, otherwise `runtime.profile`, and `runtime.headless` picks the launch mode when this process opens the browser.
- **Aggregation** (default) fans out across the active engines, deduplicates by canonical URL, and ranks by cross-engine consensus, then best per-engine rank. It returns once the soft deadline passes with at least one success, and aborts stragglers at the hard deadline. Individual engine failures are tolerated; the tool fails only when every engine fails. Browser-backed engines are held back while an HTTP engine has produced results. They start only when the HTTP engines fail, or when no HTTP engine has produced a result by the soft deadline; an HTTP result that arrives later aborts their renders. Only a browser engine that contributes unique results is named in the notes.
- **Fallback**: with aggregation off, engines are tried in priority order and the first success wins.
- **Caching and cooldowns**: identical searches are cached for `search.cacheTtlSeconds`. An engine that returns a bot challenge is skipped for a cooldown that grows with each repeat without a success (2 minutes, then 5, then 15), and its per-host gap learns from `429`, `503`, and `Retry-After` the same way the fetch transport does. A `Retry-After` longer than the current step is honored as-is, and a successful response resets the engine's ladder. Challenge detection is shared with the fetch transport, so Cloudflare, Anubis, reCAPTCHA, hCaptcha, PerimeterX, DataDome, and consent interstitials are recognized the same way everywhere.
- **Engines** present one consistent browser identity: the page headers and client hints come from a single fingerprint whose platform matches the host. Browser-backed engines render in the shared browser with a desktop viewport and the real binary's user agent. Rendered pages block third-party ads, analytics, images, media, and fonts by default; `blocking.<category>` and `hosts.<host>.allow` adjust that. Set `browser.userDataDir` to a Chromium user data directory to reuse one profile across renders, so warmed cookies and storage persist; the path is the directory, not a `Default`/`Profile N` subdirectory. Native absolute paths work on both platforms; on Windows prefer forward slashes (`C:/Users/you/profile`) or double the backslashes in JSON.

## Limitations

- No credentialed providers and no model-grounded search.
- Google, Ecosia, and Mojeek need an installed Chrome, Chromium, or Edge; without one they drop out of the pool and the HTTP engines alone are used.
- Browser renders are slower and heavier than HTTP requests. The shared browser is capped by `runtime.maxPages` across tools and by `browser.maxPages` for this tool, and it stays warm until `browser.idleCloseSeconds` passes with no session using it.
- The profile is single-instance. Renders attach to a browser the tools started, but a browser launched by hand without the tool's instance record holds the profile lock; close it before searching. The profile directory keeps cookies and logins on disk.
- With `runtime.headless: "auto"` and a display, a search that needs a browser opens a visible Chrome window. Set `runtime.headless: true` to keep rendering headless; a headless process cannot be handed to a human to clear a CAPTCHA.
- Public endpoints may throttle or block automated searches, including browser renders; results depend on the engine that happens to answer.

## License and provenance

Behavior and code are adapted from `oh-my-pi` (MIT, Stencil Labs). See [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). Original code in this repository is MIT; see [LICENSE](../../LICENSE).
