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

`Method` names the stage that produced the content, such as `readability`, `json`, `feed`, `md-suffix`, `github-repo`, `browser`, or `raw-html`.

## Configuration

`web_fetch` reads `web-tools.json` from the pi agent directory and, when the project is trusted, from `<cwd>/.pi/`. Values in the project file override the global file; per-call arguments override both.

| Key                         | Default | Effect                                                                          |
| --------------------------- | ------- | ------------------------------------------------------------------------------- |
| `fetch.maxChars`            | 500000  | Maximum rendered characters per fetch.                                          |
| `fetch.timeoutSeconds`      | 30      | Wall-clock fetch deadline.                                                      |
| `fetch.maxBytes`            | 50 MiB  | Maximum response bytes read.                                                    |
| `fetch.remoteFallbacks`     | `false` | Enable the Jina remote reader.                                                  |
| `fetch.externalReaders`     | `true`  | Use `trafilatura`/`lynx` when on `PATH`.                                        |
| `fetch.allowPrivateHosts`   | `false` | Disable the SSRF guard for local hosts.                                         |
| `browser.enabled`           | `true`  | Enable browser rendering when a binary resolves.                                |
| `browser.executablePath`    | unset   | Pin a specific Chrome/Chromium executable.                                      |
| `browser.userDataDir`       | unset   | Reuse a persistent Chromium profile across launches.                            |
| `browser.stealth`           | `false` | Reserved for future stealth patches.                                            |
| `browser.noSandbox`         | `false` | Add `--no-sandbox` for root/containers.                                         |
| `browser.timeoutSeconds`    | `20`    | Upper bound on a single browser navigation; a shorter tool deadline still wins. |
| `browser.idleCloseSeconds`  | `120`   | Close the shared browser after this idle period; `0` disables idle close.       |
| `browser.maxPages`          | `2`     | Maximum concurrent browser pages.                                               |
| `browser.allowPrivateHosts` | `false` | Permit private hosts in the browser.                                            |

Secrets stay in the environment: `GITHUB_TOKEN` or `GH_TOKEN`, `NCBI_API_KEY`, and `JINA_API_KEY`. `PUPPETEER_EXECUTABLE_PATH` overrides the browser binary and takes precedence over `browser.executablePath`.

### Browser rendering

Browser rendering activates automatically when a Chrome, Chromium, or Edge binary resolves. Resolution order is `PUPPETEER_EXECUTABLE_PATH`, then `browser.executablePath`, then a detected system browser on `PATH` and the usual install locations. The extension never downloads a browser; when none resolves, browser rendering is silently unavailable and behavior is unchanged.

A dedicated Chrome for Testing build is preferred over a daily-use browser: it keeps a stable Chromium version for `puppeteer-core` and avoids macOS handing a background launch the user's open-URL events. Download a build from the Chrome for Testing page, unpack it, and point `browser.executablePath` (or `PUPPETEER_EXECUTABLE_PATH`) at its executable.

### Persistent browser profile

By default the browser launches with a throwaway profile, so cookies and site storage do not survive the process. Set `browser.userDataDir` to a Chromium user data directory to reuse one profile across launches:

```json
{ "browser": { "userDataDir": "/home/you/.pi/web-tools-profile" } }
```

The path is the user data directory (the parent of `Default`/`Profile N`), not a profile subdirectory. An absolute path is recommended; a relative path resolves against the process working directory and a leading `~` is not expanded. Native absolute paths work on both platforms: `/home/you/profile` on Linux/macOS, and `C:/Users/you/profile` or `C:\\Users\\you\\profile` on Windows. Prefer forward slashes; a Windows path in JSON must double its backslashes, and a config file containing an invalid escape is ignored. The extension keeps the directory between renders and never deletes it.

A profile can be warmed before use: launch the same browser with `--user-data-dir=<path>`, browse normally so cookies and storage are written, then close it. Later renders reuse that state. Chromium allows one instance per profile, so the manual browser must be closed before a render; otherwise the launch fails with a "browser is already running" error. Use a dedicated directory rather than a daily-use profile, since stored cookies and logins persist on disk and are shared by every browser render.

### Usage logging

`web_fetch` records one JSONL line per call when `logging.enabled` is set. The line carries the tool input (unless `logging.includeArgs` is `false`), the parser that produced the content and its `parserKind`, the HTTP `status`, `contentType`, `finalUrl`, `charCount`, truncation binding, `savedPath`, and the pipeline `notes`. See the root [README](../../README.md#usage-logging) for the shared config keys and record format.

## Behavior and fallbacks

The pipeline runs hostname-gated site handlers first, then a generic fetch and extraction path. Any handler that fails or does not apply returns control to the generic path, so layout drift never breaks a read.

- **Site handlers** produce structured markdown for GitHub, GitLab, npm, PyPI, crates.io, Wikipedia, arXiv, PubMed, RFC, Semantic Scholar, docs.rs, MDN, Hacker News, Reddit, and Stack Exchange.
- **Digestible formats** are preferred when available: a `<link rel="alternate" type="text/markdown">`, a `.md` URL variant, HTTP content negotiation, and feed alternates.
- **Reader chain**: Readability with Turndown first, then `trafilatura`, then `lynx`, then Jina, then a headless browser. Each backend must clear a quality gate before it is accepted. The browser renders the post-redirect URL and re-extracts the live DOM with Readability; when it wins, the method is `browser` and a note records that JavaScript rendering was required.
- **Fetch** uses rotating user agents, manual redirects, one `Retry-After`-aware 429 retry, a retry of bot challenges and 403s across user agents, a streamed byte cap, and charset decoding. One wall-clock deadline (`fetch.timeoutSeconds`) bounds the whole call, including digest probes and handler fan-out.
- **Safety**: only `http` and `https` are allowed, and loopback, private, link-local, and cloud-metadata ranges are rejected unless `fetch.allowPrivateHosts` is set. Redirects are re-checked on every hop, and credential headers (`Authorization`, `Cookie`) are dropped when a redirect changes origin. External readers re-fetch the URL themselves, so they are skipped when the URL fails the guard. The browser re-checks the initial URL, resolves the DNS for every navigation (redirects and scripted navigation included) with the same guard, and aborts non-`http(s)` and private/metadata requests during navigation.

Long output is capped by the lower of `fetch.maxChars`/`max_chars` and pi's model-safe limit. Line selectors and `save_path` run against the full rendered body, and only the text returned to the model is capped: a tail selector reads the true tail, and a saved file is complete. The result names which limit bound it and suggests a selector range or `save_path` for the rest; when `save_path` is set, the saved location is reported. When the rendered document exceeds `fetch.maxChars`, the render cap is reported even if a selector reduced the returned text below it.

## Limitations

- No binary or document conversion (PDF, DOCX, XLSX, PPTX, EPUB), no images, archives, SQLite, or notebooks.
- Browser rendering needs an installed Chrome, Chromium, or Edge; without one, JavaScript-rendered pages fall back to raw HTML.
- The browser blocks non-`http(s)` schemes and literal private, loopback, link-local, and metadata hosts, and resolves the DNS for every navigation so a public hostname that redirects or is scripted to a private address is blocked. Subresources are checked literally only, so a public hostname that resolves to a private address in a subresource (an image or script) is not blocked; subresource DNS-rebinding hardening is best-effort.
- Browser launches are slow and memory-heavy; a shared browser is idle-closed and its page count is capped by `browser.maxPages`.
- A persistent `browser.userDataDir` is single-instance: a render fails while a manually launched browser holds the same profile, and the directory keeps cookies and logins on disk.
- The optional `trafilatura` and `lynx` readers are used only when already installed.
- Public sites may block automated requests, including browser renders; the tool reports the failure rather than retrying indefinitely.

## License and provenance

Behavior and code are adapted from `oh-my-pi` (MIT, Stencil Labs). See [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). Original code in this repository is MIT; see [LICENSE](../../LICENSE).
