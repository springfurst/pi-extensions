# web_fetch

## Overview

`web_fetch` reads a URL and returns readable text for the model. It is the tool to reach for when the URL is already known: documentation pages, articles, API responses, feeds, and source files. HTML is rendered to markdown, JSON is pretty-printed, and feeds are converted to markdown.

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

`Method` names the stage that produced the content, such as `readability`, `json`, `feed`, `md-suffix`, `github-repo`, or `raw-html`.

## Configuration

`web_fetch` reads `web-tools.json` from the pi agent directory and, when the project is trusted, from `<cwd>/.pi/`. Values in the project file override the global file; per-call arguments override both.

| Key                       | Default | Effect                                   |
| ------------------------- | ------- | ---------------------------------------- |
| `fetch.maxChars`          | 500000  | Maximum rendered characters per fetch.   |
| `fetch.timeoutSeconds`    | 30      | Wall-clock fetch deadline.               |
| `fetch.maxBytes`          | 50 MiB  | Maximum response bytes read.             |
| `fetch.remoteFallbacks`   | `false` | Enable the Jina remote reader.           |
| `fetch.externalReaders`   | `true`  | Use `trafilatura`/`lynx` when on `PATH`. |
| `fetch.allowPrivateHosts` | `false` | Disable the SSRF guard for local hosts.  |

Secrets stay in the environment: `GITHUB_TOKEN` or `GH_TOKEN`, `NCBI_API_KEY`, and `JINA_API_KEY`.

## Behavior and fallbacks

The pipeline runs hostname-gated site handlers first, then a generic fetch and extraction path. Any handler that fails or does not apply returns control to the generic path, so layout drift never breaks a read.

- **Site handlers** produce structured markdown for GitHub, GitLab, npm, PyPI, crates.io, Wikipedia, arXiv, PubMed, RFC, Semantic Scholar, docs.rs, MDN, Hacker News, Reddit, and Stack Exchange.
- **Digestible formats** are preferred when available: a `<link rel="alternate" type="text/markdown">`, a `.md` URL variant, HTTP content negotiation, and feed alternates.
- **Reader chain**: Readability with Turndown first, then `trafilatura`, then `lynx`, then Jina. Each backend must clear a quality gate before it is accepted.
- **Fetch** uses rotating user agents, manual redirects, one `Retry-After`-aware 429 retry, a retry of bot challenges and 403s across user agents, a streamed byte cap, and charset decoding. One wall-clock deadline (`fetch.timeoutSeconds`) bounds the whole call, including digest probes and handler fan-out.
- **Safety**: only `http` and `https` are allowed, and loopback, private, link-local, and cloud-metadata ranges are rejected unless `fetch.allowPrivateHosts` is set. Redirects are re-checked on every hop. External readers re-fetch the URL themselves, so they are skipped when the URL fails the guard.

Long output is capped by the lower of `fetch.maxChars`/`max_chars` and pi's model-safe limit. Line selectors and `save_path` run against the full rendered body, and only the text returned to the model is capped: a tail selector reads the true tail, and a saved file is complete. The result names which limit bound it and suggests a selector range or `save_path` for the rest; when `save_path` is set, the saved location is reported. When the rendered document exceeds `fetch.maxChars`, the render cap is reported even if a selector reduced the returned text below it.

## Limitations

- No binary or document conversion (PDF, DOCX, XLSX, PPTX, EPUB), no images, archives, SQLite, or notebooks.
- No headless browser, so JavaScript-rendered pages fall back to the raw HTML.
- The optional `trafilatura` and `lynx` readers are used only when already installed.
- Public sites may block automated requests; the tool reports the failure rather than retrying indefinitely.

## License and provenance

Behavior and code are adapted from `oh-my-pi` (MIT, Stencil Labs). See [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). Original code in this repository is MIT; see [LICENSE](../../LICENSE).
