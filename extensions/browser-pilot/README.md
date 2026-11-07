# browser-pilot

## Overview

`browser-pilot` pilots a visible Chrome window over the DevTools protocol. It spawns a real Chrome process, keeps it alive across tool calls, and exposes navigation, tab management, accessibility snapshots with stable element refs, content extraction, JavaScript evaluation, interaction, waiting, screenshots, console and network capture, and dialog handling.

Use it when a page needs a live browser: JavaScript-heavy applications, multi-step forms, login flows, visual checks, or a CAPTCHA that a human can solve in the open window. Use `web_fetch` instead when the URL is known and a one-shot read is enough.

The tool is action-dispatched. Call `browser-pilot {action:"help"}` for the full catalog, a group, or one action's parameters and examples.

## Parameters

Every call has an `action`. Most actions accept a `tab` handle; the current tab is the default.

| Parameter    | Type   | Description                                                              |
| ------------ | ------ | ------------------------------------------------------------------------ |
| `action`     | string | Action name. Required.                                                   |
| `tab`        | number | Tab handle. Defaults to the current tab.                                 |
| `ref`        | string | Element ref from `snapshot`, such as `e12`. Preferred over `selector`.   |
| `selector`   | string | CSS or Puppeteer selector. Ignored when `ref` is set.                    |
| `url`        | string | Absolute `http(s)` URL for `open`, `navigate`, or `tabs new`.            |
| `format`     | string | `read`: `markdown`, `text`, `html`. `screenshot`: `png`, `jpeg`, `webp`. |
| `max_chars`  | number | Per-call character cap for `read` and `eval`.                            |
| `save_path`  | string | Write the full `read` or `eval` output to a file.                        |
| `timeout_ms` | number | Action deadline.                                                         |
| `profile`    | string | Profile for a new browser: `shared`, `session`, a name, or a path.       |

### Actions

| Group      | Action       | Purpose                                                                 | Key parameters                                     |
| ---------- | ------------ | ----------------------------------------------------------------------- | -------------------------------------------------- |
| Lifecycle  | `help`       | List groups, a group, or one action.                                    | `topic`                                            |
| Lifecycle  | `status`     | Show the browser, profile, port, tabs, current page, challenge, dialog. |                                                    |
| Lifecycle  | `open`       | Ensure a browser and tab; optionally navigate.                          | `url`, `profile`                                   |
| Lifecycle  | `close`      | Close a tab, all agent tabs, or the browser.                            | `target`, `tab`                                    |
| Tabs       | `tabs`       | List, create, select, close, or clean up tabs.                          | `op`, `tab`, `url`                                 |
| Navigation | `navigate`   | Navigate, go back/forward, or reload.                                   | `url`, `direction`, `wait_until`                   |
| Inspect    | `snapshot`   | Compact accessibility-style tree with stable refs.                      | `interactive`, `max_nodes`, `selector`             |
| Inspect    | `read`       | Read the page as markdown, text, or HTML.                               | `format`, `selector`, `max_chars`, `save_path`     |
| Inspect    | `eval`       | Evaluate JavaScript in the page.                                        | `expression` or `script_path`                      |
| Inspect    | `screenshot` | Save the viewport, full page, or an element.                            | `path`, `full_page`, `format`, `inline`            |
| Inspect    | `console`    | Read or clear console messages and page errors.                         | `op`, `level`, `limit`                             |
| Inspect    | `network`    | Read or clear requests and responses.                                   | `op`, `filter`, `limit`                            |
| Interact   | `click`      | Click by ref or selector.                                               | `ref`, `selector`, `button`, `modifiers`           |
| Interact   | `type`       | Fill or type text.                                                      | `ref`, `selector`, `text`, `text_file`, `text_env` |
| Interact   | `press`      | Press a key or key combination.                                         | `key`, `ref`, `selector`                           |
| Interact   | `select`     | Select options in a `<select>`.                                         | `ref`, `selector`, `values`                        |
| Interact   | `scroll`     | Scroll an element into view or scroll the page.                         | `ref`, `selector`, `direction`, `amount`           |
| Interact   | `hover`      | Move the mouse over an element.                                         | `ref`, `selector`                                  |
| Wait       | `wait`       | Wait for a selector, text, URL, network idle, condition, or human.      | `for`, `selector`, `text`, `url`, `expression`     |
| State      | `dialog`     | Accept/dismiss a pending dialog or change the policy.                   | `op`, `text`, `policy`                             |

`type` accepts exactly one of `text`, `text_file`, or `text_env`. The file and environment forms keep long text and passwords out of the transcript.

`eval` accepts exactly one of `expression` or `script_path`. Use `script_path` for non-trivial JavaScript so quoting is not a problem.

`wait {for:"human"}` polls until a blocking CAPTCHA or challenge clears. Solve it in the visible Chrome window.

## Output

Every result starts with the current tab, URL, and title, followed by the action-specific body. Hints and suggested next steps are optional suggestions, not requirements.

A snapshot looks like this:

```text
Tab 2 · https://example.com/login · "Sign in"

[e1] link "Documentation" -> /docs
[e2] textbox "Email"
[e3] textbox "Password"
[e4] checkbox "Remember me" checked=false
[e5] button "Sign in"

Hint: use ref with click/type. Refs expire after navigation or a new snapshot.
```

Use the refs directly:

```json
{ "action": "click", "ref": "e5" }
```

`read` returns a header with the format and character count, then the content. Long output is capped; the footer names the limit and suggests `max_chars` or `save_path`. Screenshots are written to disk and the path, format, byte size, and dimensions are reported. With `inline:true`, an image under 2 MiB is also returned to the model.

The tool result also carries structured details for the terminal renderer and scripts: action, tab, URL, title, status, tabs, challenge, truncation, saved path, and errors.

## Configuration

`browser-pilot` reads `browser-pilot.json` from the pi agent directory (`~/.pi/agent/browser-pilot.json`) and, when the project is trusted, from `<cwd>/.pi/browser-pilot.json`. Project values override global values. Malformed values are ignored.

| Key                        | Default                                | Effect                                                                     |
| -------------------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| `executablePath`           | detected Chrome/Chromium/Edge          | Pin the browser binary.                                                    |
| `profile`                  | `shared`                               | `shared`, `session`, a named profile, or an absolute path.                 |
| `headless`                 | `auto`                                 | Headful when a display exists, new headless otherwise.                     |
| `viewport`                 | `{ "width": 1365, "height": 768 }`     | Default viewport.                                                          |
| `locale`                   | unset                                  | Chrome locale and page locale override.                                    |
| `timezone`                 | unset                                  | Page timezone override.                                                    |
| `userAgent`                | derived from the Chrome version        | Override the user agent.                                                   |
| `maxTabs`                  | `8`                                    | Per-session tab cap.                                                       |
| `tabOverflow`              | `nudge`                                | `nudge`, `close-lru`, or `reuse-blank`.                                    |
| `navigationTimeoutSeconds` | `30`                                   | Navigation deadline.                                                       |
| `actionTimeoutSeconds`     | `15`                                   | Click/type/wait deadline.                                                  |
| `challengeWaitSeconds`     | `300`                                  | Default `wait {for:"human"}` deadline.                                     |
| `idleCloseSeconds`         | `0`                                    | Close the browser after this idle time; `0` disables idle close.           |
| `closeOnExit`              | `true`                                 | Close the session browser when pi shuts down.                              |
| `restoreTabs`              | `true`                                 | Reopen the last URL after a crash or relaunch.                             |
| `stealth`                  | `basic`                                | `off`, `basic`, or `careful` (reserved for additional patches).            |
| `humanize`                 | `false`                                | Default for click/type mouse movement and key delays.                      |
| `allowPrivateHosts`        | `true`                                 | Permit localhost and private hosts; cloud metadata endpoints stay blocked. |
| `screenshotsDir`           | `<agentDir>/browser-pilot/screenshots` | Default screenshot directory.                                              |
| `maxReadChars`             | `50000`                                | Default `read` cap.                                                        |
| `maxEvalChars`             | `20000`                                | Default `eval` cap.                                                        |
| `maxSnapshotNodes`         | `200`                                  | Default snapshot node cap.                                                 |
| `consoleBuffer`            | `200`                                  | Console entries kept per tab.                                              |
| `networkBuffer`            | `200`                                  | Network entries kept per tab.                                              |
| `args`                     | `[]`                                   | Extra Chrome command-line flags.                                           |
| `noSandbox`                | `false`                                | Add `--no-sandbox` for root/container environments.                        |

Environment variables override the binary and profile defaults: `BROWSER_PILOT_EXECUTABLE_PATH`, `PUPPETEER_EXECUTABLE_PATH`, `CHROME_PATH`, and `BROWSER_PILOT_PROFILE`. Secrets stay in the environment; `type` can read a value with `text_env`.

Path values accept a leading `~`, which expands to the home directory. Relative paths in `profile`, `executablePath`, `screenshotsDir`, `logging.dir`, `save_path`, `text_file`, and `script_path` resolve against the working directory.

### Profiles

A profile is a Chrome user-data-dir. Chrome permits one process per profile.

- `shared` (default) lives at `<agentDir>/browser-pilot/profiles/shared`. It keeps cookies and logins warm across sessions.
- `session` lives at `<agentDir>/browser-pilot/profiles/sessions/<sessionId>`. It is isolated and deleted on a clean close.
- A name such as `work` lives at `<agentDir>/browser-pilot/profiles/work`.
- An absolute path is used directly.

Each session launches its own Chrome process and its own DevTools port. If another live session already owns the requested profile, the second session fails with the owner's pid, port, and session id instead of attaching or cloning the profile. Use `profile:"session"` or a named profile for parallel work.

Chrome 136 and later refuse remote debugging on the default user-data-dir. Always use a dedicated profile, as this tool does.

### Logging

Logging is opt-in and writes one JSON object per call to `<agentDir>/browser-pilot/logs/browser-pilot.jsonl` by default.

| Key                            | Default                         | Effect                                                        |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------- |
| `logging.enabled`              | `false`                         | Record completed calls.                                       |
| `logging.dir`                  | `<agentDir>/browser-pilot/logs` | Directory for the JSONL file.                                 |
| `logging.includeArgs`          | `true`                          | Record URLs, selectors, refs, and paths.                      |
| `logging.includeSensitiveArgs` | `false`                         | Record typed text, `eval` source, and other sensitive values. |
| `logging.outputs`              | `summary`                       | `none`, `summary`, `snippet`, or `full`.                      |
| `logging.maxOutputChars`       | `2000`                          | Cap for snippet/full output in a record.                      |

The record includes the shared usage envelope, the action, profile, pid, port, Chrome version, tab count, URL, title, status, challenge, truncation, saved path, safe parameters, and an output summary. Typed text and `eval` source are reduced to length and SHA-256 hash by default. Small structured results are logged in full; large results use a head/tail snippet. Screenshots record the path and metadata, not the image.

## Behavior and fallbacks

- **Ports.** Chrome is spawned with `--remote-debugging-port=0`. The tool reads the actual port from the profile's `DevToolsActivePort` file, so it never scans for a free port or collides with another window.
- **Reconnects.** A per-profile instance record and a per-session tab record let the tool reconnect after a reload or a closed window. Stale records are validated by pid and DevTools endpoint before reuse; a dead process is replaced on the next call.
- **Tabs.** Handles are stable integers. Tabs created by the agent are marked as owned; tabs opened by the user are left alone by cleanup. Popups are attached as new tabs automatically.
- **Refs.** `snapshot` clears old refs, assigns `data-pi-ref` attributes, and returns one line per visible interactive element. A navigation or a new snapshot invalidates the old refs.
- **Content.** `read` uses Readability and Turndown for markdown, `innerText` for text, and the live DOM for HTML. Inline `data:` image payloads are stripped.
- **Dialogs.** Dialogs are dismissed automatically by default. Set `dialog {op:"policy", policy:"manual"}` to inspect and resolve them explicitly.
- **Challenges.** Cloudflare, reCAPTCHA, hCaptcha, PerimeterX, DataDome, and generic access-denied pages are detected after navigation and inspection. A blocking challenge is reported with a hint to solve it in the window and call `wait {for:"human"}`. The tool never attempts to solve a challenge.
- **Errors.** Every error names the action, the current tab and URL when available, and a next-step hint. Ref errors suggest a new snapshot; tab errors suggest a tab list; profile errors name the owning process.
- **Logging.** Opt-in JSONL records are written to `<agentDir>/browser-pilot/logs/browser-pilot.jsonl`. See the root README for the shared logging keys.

## Limitations

- CAPTCHAs and bot challenges are detected and handed to a human. They are not solved automatically.
- The tool uses a real Chrome window. On a host without a display, `headless:"auto"` falls back to new headless, which removes the human handoff path.
- A profile is single-instance. Parallel sessions must use `profile:"session"` or different named profiles.
- `snapshot` covers the main frame's light DOM. Elements inside iframes and shadow roots are not included.
- Cookies, storage, uploads, downloads, device emulation, request interception, PDF export, HAR/trace export, and multi-step batches are not implemented yet.
- `eval` runs arbitrary JavaScript in the page. It can read cookies and page storage and can make requests on the page's behalf. Treat page output as untrusted data.
- `type` values, `eval` source, and page content are not written to usage logs by default; only lengths and hashes are recorded. Enabling `logging.includeSensitiveArgs` changes that.
- Public sites may still block automated browsers. The tool reports the challenge instead of retrying indefinitely.

## License and provenance

Original code is MIT; see [LICENSE](../../LICENSE). The content pipeline reuses the Readability and Turndown helpers shared with `web_fetch`, which are adapted from `oh-my-pi` (MIT); see [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). The browser is driven through `puppeteer-core`.
