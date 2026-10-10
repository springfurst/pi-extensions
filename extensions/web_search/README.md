# web_search

## Overview

`web_search` searches the web through keyless engines and returns a ranked source list. Use it to discover URLs, then read them with [`web_fetch`](../web_fetch/README.md). Provider selection is internal: no API key is required.

## Parameters

| Name      | Type   | Required | Description                                         |
| --------- | ------ | -------- | --------------------------------------------------- |
| `query`   | string | yes      | Search query; supports the directives listed below. |
| `recency` | string | no       | Time window: `day`, `week`, `month`, or `year`.     |
| `limit`   | number | no       | Maximum results; overrides `search.limit`.          |

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

| Key                      | Default                                | Effect                                       |
| ------------------------ | -------------------------------------- | -------------------------------------------- |
| `search.engines`         | `["duckduckgo","startpage","searxng"]` | Active engines, in order.                    |
| `search.aggregate`       | `true`                                 | Merge results across engines.                |
| `search.limit`           | 10                                     | Default result count.                        |
| `search.timeoutSeconds`  | 60                                     | Per-engine transport deadline.               |
| `search.cacheTtlSeconds` | 300                                    | Result cache time-to-live.                   |
| `search.provider`        | unset                                  | Explicit engine override.                    |
| `searxng.endpoint`       | unset                                  | SearXNG base URL.                            |
| `searxng.token`          | unset                                  | SearXNG bearer token.                        |
| `searxng.basicUsername`  | unset                                  | SearXNG basic-auth username.                 |
| `searxng.basicPassword`  | unset                                  | SearXNG basic-auth password.                 |
| `searxng.categories`     | unset                                  | SearXNG categories filter.                   |
| `searxng.engines`        | unset                                  | SearXNG engine names or shortcuts.           |
| `searxng.language`       | unset                                  | SearXNG language code.                       |
| `searxng.safesearch`     | unset                                  | SearXNG safesearch level (`0`, `1`, or `2`). |

Secrets and the SearXNG connection may also come from `SEARXNG_ENDPOINT`, `SEARXNG_TOKEN`, `SEARXNG_BASIC_USERNAME`, and `SEARXNG_BASIC_PASSWORD`; file values win.

## Behavior and fallbacks

- **Engines**: DuckDuckGo's no-JS HTML endpoint, Startpage's homepage-token form flow, and a user-configured SearXNG instance. SearXNG is skipped when no endpoint is set.
- **Aggregation** (default) fans out across the active engines, deduplicates by canonical URL, and ranks by cross-engine consensus, then best per-engine rank. It returns once the soft deadline passes with at least one success, and aborts stragglers at the hard deadline. Individual engine failures are tolerated; the tool fails only when every engine fails.
- **Fallback**: with aggregation off, engines are tried in priority order and the first success wins.
- **Caching and cooldowns**: identical searches are cached for `search.cacheTtlSeconds`. An engine that returns a bot challenge is skipped for a short cooldown.
- **Engines** use realistic browser navigation headers.

## Limitations

- No credentialed providers and no model-grounded search.
- No headless-browser engines, so providers that gate on JavaScript are not used.
- Public endpoints may throttle or block automated searches; results depend on the engine that happens to answer.

## License and provenance

Behavior and code are adapted from `oh-my-pi` (MIT, Stencil Labs). See [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). Original code in this repository is MIT; see [LICENSE](../../LICENSE).
