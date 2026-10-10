# Third-Party Notices

Files in this repository that are derived from third-party code are listed here. Each entry records the source, its copyright holders, the license terms that keep applying, and the affected paths.

Derived code stays under its original license. The repository license (MIT, see [LICENSE](LICENSE)) applies to everything not listed in this file. Files that are derived carry an `SPDX-License-Identifier` header and a provenance line naming this file.

## oh-my-pi

- Source: [oh-my-pi](https://omp.sh)
- Copyright: Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük; Copyright (c) 2026 Stencil Labs, Inc.
- License: MIT
- Affected paths:
  - `extensions/web_fetch/` — URL reader pipeline, fetch layer, selectors, extraction, output shaping, and the site-specific scraper set
  - `extensions/web_search/` — query parser and constraint filter, engine HTML/JSON parsers, aggregation, and result formatting
  - `lib/format.ts`, `lib/http.ts` — formatting and bounded-response helpers adapted from upstream utilities

The behaviors and implementations above were adapted from oh-my-pi's web tools. The port drops oh-my-pi's runtime coupling (tool sessions, auth storage, model registry, native addon, settings framework), replaces the native HTML-to-markdown converter with Readability and Turndown, and reduces the search provider set to keyless engines.

## Runtime dependencies

These packages are imported by the extensions at runtime and remain under their own licenses:

| Package                | License    |
| ---------------------- | ---------- |
| `linkedom`             | ISC        |
| `@mozilla/readability` | Apache-2.0 |
| `turndown`             | MIT        |
| `turndown-plugin-gfm`  | MIT        |
