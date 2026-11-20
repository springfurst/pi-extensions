# browser-pilot

## Overview

`browser-pilot` browses the web in a real Chrome window. It is useful for a simple page read as well as complex browser work: it runs JavaScript, keeps a real profile, follows login flows, and hands CAPTCHAs to a human instead of failing. It exposes navigation, tab and frame management, accessibility snapshots with stable element refs, content extraction, JavaScript evaluation, interaction, waiting, screenshots, performance metrics, PDF export, console and network capture, HAR and trace recording, cookies, storage, auth-state export and import, emulation, permissions, clipboard access, request interception, assertions, batches, and dialog handling. It can also attach to an existing Chrome DevTools endpoint.

Start with `{action:"open", params:{url:"https://example.com"}}` then `{action:"read"}`. Interact with `{action:"snapshot"}` then `{action:"click", params:{ref:"e5"}}` or `{action:"type", params:{ref:"e3", text:"..."}}`. Use `{action:"eval", params:{expression:"document.title"}}`, `{action:"console"}`, and `{action:"network"}` for JavaScript, page logs, and requests.

The tool is action-dispatched. Call `{action:"help"}` to list topic groups, `{action:"help", params:{group:"inspect"}}` to see a group's actions, or `{action:"help", params:{action:"snapshot"}}` for one action's parameters and examples.

## Parameters

Every call has an `action` and an optional `params` object. Omit `params` when the action takes none.

| Parameter | Type   | Description                                                                                |
| --------- | ------ | ------------------------------------------------------------------------------------------ |
| `action`  | string | Action name. Required.                                                                     |
| `params`  | object | Action-specific parameters. The fields below and `help` describe what each action accepts. |

`params` fields:

| Field                                                                                                                                                  | Type     | Description                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `tab`                                                                                                                                                  | number   | Tab handle. Defaults to the current tab.                                                                                  |
| `ref`                                                                                                                                                  | string   | Element ref from `snapshot`, such as `e12`. Preferred over `selector` where supported.                                    |
| `selector`                                                                                                                                             | string   | CSS or Puppeteer selector. Ignored when `ref` is set.                                                                     |
| `url`                                                                                                                                                  | string   | Absolute `http(s)` URL for `open`, `navigate`, or `tabs new`.                                                             |
| `format`                                                                                                                                               | string   | `read`: `markdown`, `text`, `html`, `outline`. `screenshot`: `png`, `jpeg`, `webp`.                                       |
| `max_chars`                                                                                                                                            | number   | Per-call character cap for `read`, `eval`, and network body previews.                                                     |
| `save_path`                                                                                                                                            | string   | Write the full `read` or `eval` output to a file.                                                                         |
| `timeout_ms`                                                                                                                                           | number   | Action deadline.                                                                                                          |
| `group`                                                                                                                                                | string   | `help`: topic group to describe: `lifecycle`, `tabs`, `navigation`, `inspect`, `interact`, `wait`, `state`, `batch`.      |
| `action`                                                                                                                                               | string   | `help`: action to describe, such as `snapshot` or `click`.                                                                |
| `direction`                                                                                                                                            | string   | `navigate`: `back`, `forward`, `reload`. `scroll`: `up`, `down`, `top`, `bottom`.                                         |
| `wait_until`                                                                                                                                           | string   | `navigate`: `load`, `domcontentloaded`, `networkidle0`, `networkidle2`.                                                   |
| `target`                                                                                                                                               | string   | `close`: `tab`, `tabs`, `browser`.                                                                                        |
| `interactive`                                                                                                                                          | boolean  | `snapshot`: only interactive elements (default true).                                                                     |
| `max_nodes`                                                                                                                                            | number   | `snapshot`: maximum nodes to return.                                                                                      |
| `expression`                                                                                                                                           | string   | `eval`: inline JavaScript. `wait {until:"function"}`: truthy expression.                                                  |
| `script_path`                                                                                                                                          | string   | `eval`: read the JavaScript from this file.                                                                               |
| `await_promise`                                                                                                                                        | boolean  | `eval`: await a returned promise (default true).                                                                          |
| `button`                                                                                                                                               | string   | `click`: `left`, `right`, `middle`.                                                                                       |
| `click_count`                                                                                                                                          | number   | `click`: number of clicks.                                                                                                |
| `modifiers`                                                                                                                                            | string[] | `click`: `Alt`, `Control`, `Meta`, `Shift`.                                                                               |
| `humanize`                                                                                                                                             | boolean  | `click`/`type`: mouse movement and per-key delays.                                                                        |
| `text`                                                                                                                                                 | string   | `type`, `dialog`, or `clipboard`: inline text.                                                                            |
| `text_file`                                                                                                                                            | string   | `type` or `clipboard`: read text from a file.                                                                             |
| `text_env`                                                                                                                                             | string   | `type` or `clipboard`: read text from an environment variable.                                                            |
| `clear`                                                                                                                                                | boolean  | `type`: clear the field before typing (default true).                                                                     |
| `submit`                                                                                                                                               | boolean  | `type`: press Enter after typing (default false).                                                                         |
| `delay_ms`                                                                                                                                             | number   | `type`: key delay. `route`: delay before continuing.                                                                      |
| `values`                                                                                                                                               | string[] | `select`: option values or labels.                                                                                        |
| `pixels`                                                                                                                                               | number   | `scroll`: pixels for up/down.                                                                                             |
| `until`                                                                                                                                                | string   | `wait`: `selector`, `text`, `url`, `network_idle`, `response`, `function`, `human`.                                       |
| `path`                                                                                                                                                 | string   | `screenshot`, `pdf`, `har`, `trace`, or `state`: output path.                                                             |
| `full_page`                                                                                                                                            | boolean  | `screenshot`: capture the full scrollable page.                                                                           |
| `quality`                                                                                                                                              | number   | `screenshot`: JPEG/WebP quality from 0 to 100.                                                                            |
| `inline_image`                                                                                                                                         | boolean  | `screenshot`: return small images to the model.                                                                           |
| `level`                                                                                                                                                | string   | `console`: `log`, `info`, `warn`, `error`, `debug`.                                                                       |
| `limit`                                                                                                                                                | number   | `console`, `network`, or `download`: maximum entries.                                                                     |
| `filter`                                                                                                                                               | string   | `network` or `download`: URL or filename substring.                                                                       |
| `policy`                                                                                                                                               | string   | `dialog`: `dismiss`, `accept`, `manual`.                                                                                  |
| `profile`                                                                                                                                              | string   | Profile for a new browser: `shared`, `session`, a name, or a path.                                                        |
| `endpoint`                                                                                                                                             | string   | `connect`: WebSocket or HTTP DevTools endpoint of an existing Chrome.                                                     |
| `files`                                                                                                                                                | string[] | `upload`: file paths for a file input.                                                                                    |
| `operation`                                                                                                                                            | string   | Operation for tabs, frames, console, network, dialog, download, cookies, storage, state, clipboard, HAR, trace, or route. |
| `key`                                                                                                                                                  | string   | `press`: key name. `storage`: storage key.                                                                                |
| `value`                                                                                                                                                | string   | `cookies` and `storage`: value to set.                                                                                    |
| `name`                                                                                                                                                 | string   | `cookies`: cookie name.                                                                                                   |
| `domain`                                                                                                                                               | string   | `cookies`: cookie domain.                                                                                                 |
| `cookie_path`                                                                                                                                          | string   | `cookies`: cookie path.                                                                                                   |
| `expires`                                                                                                                                              | number   | `cookies`: expiry as Unix seconds.                                                                                        |
| `http_only`                                                                                                                                            | boolean  | `cookies`: mark HttpOnly.                                                                                                 |
| `secure`                                                                                                                                               | boolean  | `cookies`: mark Secure.                                                                                                   |
| `same_site`                                                                                                                                            | string   | `cookies`: `Strict`, `Lax`, or `None`.                                                                                    |
| `storage_area`                                                                                                                                         | string   | `storage`: `local` or `session`.                                                                                          |
| `width`, `height`                                                                                                                                      | number   | `emulate`: viewport dimensions.                                                                                           |
| `device_scale_factor`, `is_mobile`, `has_touch`                                                                                                        | mixed    | `emulate`: viewport features.                                                                                             |
| `user_agent`, `locale`, `timezone`                                                                                                                     | string   | `emulate`: overrides.                                                                                                     |
| `color_scheme`, `reduced_motion`                                                                                                                       | string   | `emulate`: media overrides.                                                                                               |
| `network_profile`                                                                                                                                      | string   | `emulate`: `offline`, `slow3g`, `fast3g`, `slow4g`, or `fast4g`.                                                          |
| `latency`, `download_throughput`, `upload_throughput`                                                                                                  | number   | `emulate`: custom network conditions.                                                                                     |
| `cpu_throttle`                                                                                                                                         | number   | `emulate`: CPU slowdown factor.                                                                                           |
| `latitude`, `longitude`, `accuracy`                                                                                                                    | number   | `emulate`: geolocation.                                                                                                   |
| `permissions`, `origin`                                                                                                                                | mixed    | `emulate`: grant permissions for an origin.                                                                               |
| `reset`                                                                                                                                                | boolean  | `emulate`: reset overrides.                                                                                               |
| `frame`                                                                                                                                                | number   | `frames`: frame index; `0` is the main frame.                                                                             |
| `annotate`                                                                                                                                             | boolean  | `screenshot`: draw ref boxes and labels before capture.                                                                   |
| `stack_traces`                                                                                                                                         | boolean  | `console`: include stack traces.                                                                                          |
| `include_body`                                                                                                                                         | boolean  | `network`/`wait`: include a response body preview.                                                                        |
| `request_id`                                                                                                                                           | string   | `network`: request id from the overview, such as `r12`, for `operation:"get"`.                                            |
| `duration_ms`, `color`                                                                                                                                 | mixed    | `highlight`: outline duration and color.                                                                                  |
| `paper_format`, `landscape`, `print_background`, `scale`, `page_ranges`, `margin`                                                                      | mixed    | `pdf`: print options.                                                                                                     |
| `url_pattern`, `resource_type`, `route_action`, `response_status`, `response_body`, `response_content_type`, `response_headers`, `delay_ms`, `rule_id` | mixed    | `route`: interception rule. Route ids look like `rt1`.                                                                    |
| `check`, `operator`, `expected`, `attribute`                                                                                                           | mixed    | `expect`: assertion.                                                                                                      |
| `steps`, `stop_on_error`                                                                                                                               | mixed    | `steps`: batch actions and failure policy.                                                                                |

### Actions

| Group      | Action       | Purpose                                                                   | Key parameters                                                               |
| ---------- | ------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Lifecycle  | `help`       | List groups, a group, or one action.                                      | `group` or `action`                                                          |
| Lifecycle  | `status`     | Show the browser, profile, port, tabs, current page, challenge, dialog.   |                                                                              |
| Lifecycle  | `doctor`     | Check binary, profile, port, display, sandbox, directories, stale state.  |                                                                              |
| Lifecycle  | `open`       | Ensure a browser and tab; optionally navigate.                            | `url`, `profile`                                                             |
| Lifecycle  | `close`      | Close a tab, all agent tabs, or the browser.                              | `target`, `tab`                                                              |
| Lifecycle  | `connect`    | Attach to an existing Chrome DevTools endpoint.                           | `endpoint`                                                                   |
| Batch      | `steps`      | Run several actions in order and return each result.                      | `steps`, `stop_on_error`                                                     |
| Tabs       | `tabs`       | List, create, select, close, or clean up tabs.                            | `operation`, `tab`, `url`                                                    |
| Tabs       | `frames`     | List frames, select a frame, or return to the main frame.                 | `operation`, `frame`                                                         |
| Navigation | `navigate`   | Navigate, go back/forward, or reload.                                     | `url`, `direction`, `wait_until`                                             |
| Inspect    | `snapshot`   | Compact accessibility-style tree with stable refs.                        | `interactive`, `max_nodes`, `selector`                                       |
| Inspect    | `read`       | Read the page as markdown, text, HTML, or an outline.                     | `format`, `ref`, `selector`, `max_chars`, `save_path`                        |
| Inspect    | `eval`       | Evaluate JavaScript in the page.                                          | `expression` or `script_path`                                                |
| Inspect    | `screenshot` | Save the viewport, full page, or an element; optionally annotate refs.    | `path`, `ref`, `selector`, `full_page`, `format`, `inline_image`, `annotate` |
| Inspect    | `metrics`    | Show heap, DOM, navigation timing, and resource metrics.                  |                                                                              |
| Inspect    | `console`    | Read or clear console messages and page errors.                           | `operation`, `level`, `limit`                                                |
| Inspect    | `network`    | Read a compact request overview, inspect one request by id, or clear.     | `operation`, `filter`, `limit`, `request_id`, `include_body`                 |
| Inspect    | `pdf`        | Print the current page to a PDF file.                                     | `path`, `paper_format`, `landscape`, `margin`                                |
| Inspect    | `har`        | Record network activity and export a HAR 1.2 file.                        | `operation`, `path`                                                          |
| Inspect    | `trace`      | Record a Chrome trace and write it as JSON.                               | `operation`, `path`                                                          |
| Interact   | `click`      | Click by ref or selector.                                                 | `ref`, `selector`, `button`, `modifiers`                                     |
| Interact   | `type`       | Fill or type text.                                                        | `ref`, `selector`, `text`, `text_file`, `text_env`                           |
| Interact   | `press`      | Press a key or key combination.                                           | `key`, `ref`, `selector`                                                     |
| Interact   | `select`     | Select options in a `<select>`.                                           | `ref`, `selector`, `values`                                                  |
| Interact   | `scroll`     | Scroll an element into view or scroll the page.                           | `ref`, `selector`, `direction`, `pixels`                                     |
| Interact   | `hover`      | Move the mouse over an element.                                           | `ref`, `selector`                                                            |
| Interact   | `highlight`  | Flash an element outline for human handoff.                               | `ref`, `selector`, `duration_ms`, `color`                                    |
| Interact   | `upload`     | Set the files of a file input.                                            | `ref`, `selector`, `files`                                                   |
| Wait       | `wait`       | Wait for a selector, text, URL, network idle, response, condition, human. | `until`, `ref`, `selector`, `text`, `url`, `url_pattern`                     |
| Wait       | `expect`     | Assert text, URL, title, values, attributes, visibility, or counts.       | `check`, `operator`, `expected`, `ref`, `selector`, `attribute`              |
| State      | `dialog`     | Accept/dismiss a pending dialog or change the policy.                     | `operation`, `text`, `policy`                                                |
| State      | `download`   | List, wait for, or clear browser downloads.                               | `operation`, `filter`, `timeout_ms`                                          |
| State      | `cookies`    | List, set, delete, or clear cookies.                                      | `operation`, `name`, `value`, `url`, `domain`                                |
| State      | `storage`    | Read or mutate localStorage and sessionStorage.                           | `operation`, `storage_area`, `key`, `value`                                  |
| State      | `state`      | Export or import cookies and per-origin storage as JSON.                  | `operation`, `path`                                                          |
| State      | `clipboard`  | Read from or write to the system clipboard.                               | `operation`, `text`, `text_file`, `text_env`                                 |
| State      | `emulate`    | Apply or reset viewport, media, network, CPU, locale, and geolocation.    | `width`, `height`, `network_profile`, `reset`                                |
| State      | `route`      | Add, remove, list, or clear request interception rules.                   | `operation`, `url_pattern`, `route_action`, `rule_id`                        |

`type` accepts exactly one of `text`, `text_file`, or `text_env`. The file and environment forms keep long text and passwords out of the transcript.

`eval` accepts exactly one of `expression` or `script_path`. Use `script_path` for non-trivial JavaScript so quoting is not a problem.

`{action:"wait", params:{until:"human"}}` polls until a blocking CAPTCHA or challenge clears. Solve it in the visible Chrome window.

`steps` runs a list of action objects in one call. Set `stop_on_error:false` to continue after a failing step. Nested `steps` are rejected.

`expect` polls until the assertion passes or `timeout_ms` expires. Text and title default to `contains`; other checks default to `equals`. Use `matches` for a regular expression and `gt`/`lt`/`gte`/`lte` for numeric comparisons.

## Output

Most action results start with the current tab, URL, and title, followed by the action-specific body. Catalog, status, doctor, and list results have their own shapes. Hints and suggested next steps are optional suggestions, not requirements.

URLs in results are shortened for display: the origin and the start of the path stay readable, and a long query string or fragment collapses to `?…` or `#…`. The full URL is still available from `{action:"eval", params:{expression:"location.href"}}`.

The terminal view keeps the call and its result separate. The call line always shows the action and a compact form of every argument, such as `browser-pilot click · ref=e5 · tab=2` or `browser-pilot eval · expression="document.title"`. Long values are shortened, `text_env` shows the variable name instead of its value, and the whole argument list is truncated to fit the terminal width.

The result line shows the outcome, then the shortened URL and title:

```text
browser-pilot click · ref=e5
button "Sign in"
selected US
https://example.com/login
"Sign in · Example"
```

That summary is `subject` (the element, named the way snapshots name it) and `preview` (typed text, read content, selected options, pressed keys, the awaited condition, or an action-specific result). Element subjects never include a password value. Typed text that came from `text_env` or `text_file` is reduced to a length and its source. When an action has neither, the first body line stands in. For `eval`, the result line previews the returned value rather than repeating the expression.

Expanding a call shows the full arguments, including values that were shortened or omitted from the compact line. JavaScript expressions are syntax-highlighted, and structured argument values are shown as highlighted JSON. Expanding a result shows the full body under an `Output` heading. Readable page Markdown is rendered as Markdown, HTML is highlighted as HTML, and `eval` results are highlighted as JSON or HTML when their shape is recognizable. Snapshot refs, network status codes, console levels, steps, tabs, and help output use semantic colors. Expanded errors include the full message, arguments, and details.

The expanded view has no fixed line cap. Output remains bounded by the model-safe limit and by the action-specific limits described below, so very large results can still be truncated. The expand key is pi's configured tool-expansion keybinding, `Ctrl+O` by default.

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
{ "action": "click", "params": { "ref": "e5" } }
```

`read` returns a header with the format and character count, then the content. Long output is capped; the footer names the limit and suggests `max_chars` or `save_path`. `format:"outline"` returns a compact structural tree for HTML-heavy pages. Screenshots are written to disk and the path, format, byte size, and dimensions are reported. With `inline_image:true`, an image under 2 MiB is also returned to the model; with `annotate:true`, current snapshot refs are drawn as labelled boxes before capture.

`{action:"network", params:{operation:"read"}}` returns a compact overview with a stable request id per line:

```text
Tab 2 · https://app.example.com · "Dashboard"
Network: 24 requests · 21 ok · 2 failed · 1 pending · 1.4MB

r21 200 GET /api/items?page=2 · xhr · application/json · 12ms · 1.4KB
r22 200 GET /api/users/me · xhr · application/json · 8ms · 312B
r23 500 POST /api/items · xhr · application/json · 41ms · 198B · net::ERR_FAILED
```

Use the id to fetch headers, request data, timing, and a body preview:

```json
{ "action": "network", "params": { "operation": "get", "request_id": "r21" } }
```

`{action:"wait", params:{until:"response", url_pattern:"/api/items"}}` returns the matching request id and summary, and can include a body preview with `include_body:true`. Bodies are read on demand from recently retained responses; use `har` when a guaranteed full capture is needed.

`steps` collapses repeated page headers into one header for the batch, and `console` collapses repeated messages as `×N`. The tool result also carries structured details for the terminal renderer and scripts: action, tab, URL, title, status, subject, preview, tabs, challenge, truncation, saved path, and errors.

## Configuration

`browser-pilot` reads `browser-pilot.json` from the pi agent directory (`~/.pi/agent/browser-pilot.json`) and, when the project is trusted, from `<cwd>/.pi/browser-pilot.json`. Project values override global values. Malformed values are ignored.

| Key                          | Default                                | Effect                                                                                         |
| ---------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `executablePath`             | detected Chrome/Chromium/Edge          | Pin the browser binary; an explicit value wins over the environment.                           |
| `profile`                    | `shared`                               | `shared`, `session`, a named profile, or an absolute path.                                     |
| `headless`                   | `auto`                                 | Headful when a display exists, new headless otherwise.                                         |
| `viewport`                   | `{ "width": 1365, "height": 768 }`     | Default viewport.                                                                              |
| `locale`                     | unset                                  | Chrome locale and page locale override.                                                        |
| `timezone`                   | unset                                  | Page timezone override.                                                                        |
| `userAgent`                  | unset                                  | Override the user agent; unset keeps the real binary's identity and matching client hints.     |
| `maxTabs`                    | `8`                                    | Per-session tab cap.                                                                           |
| `runtime.profile`            | `shared`                               | Profile name; shared with `web_fetch` and `web_search`.                                        |
| `runtime.attach`             | `auto`                                 | Attach to a live DevTools endpoint instead of failing on a busy profile.                       |
| `runtime.isolation`          | `tabs`                                 | `tabs` shares the warm cookie jar, `contexts` gives the session its own cookie jar.            |
| `runtime.maxPages`           | `6`                                    | Pages allowed across every session sharing the browser.                                        |
| `runtime.headless`           | `auto`                                 | Launch mode when the web tools open the browser; this tool's `headless` wins when it launches. |
| `blocking.<category>`        | `third-party`                          | `off` or `third-party` for `ads`, `analytics`, `images`, `media`, and `fonts`.                 |
| `hosts.<host>.allow`         | unset                                  | Blocking categories this host may load despite `blocking`.                                     |
| `hosts.<host>.minIntervalMs` | curated                                | Minimum navigation gap for that host.                                                          |
| `tabOverflow`                | `nudge`                                | `nudge`, `close-lru`, or `reuse-blank`.                                                        |
| `navigationTimeoutSeconds`   | `30`                                   | Navigation deadline.                                                                           |
| `actionTimeoutSeconds`       | `15`                                   | Click/type/wait deadline.                                                                      |
| `challengeWaitSeconds`       | `300`                                  | Default `{action:"wait", params:{until:"human"}}` deadline.                                    |
| `idleCloseSeconds`           | `0`                                    | Close the browser after this idle time; `0` disables idle close.                               |
| `closeOnExit`                | `true`                                 | Close the session browser when pi shuts down.                                                  |
| `restoreTabs`                | `true`                                 | Reopen the last URL after a crash or relaunch.                                                 |
| `stealth`                    | `basic`                                | `off`, `basic`, or `careful` (reserved for additional patches).                                |
| `humanize`                   | `false`                                | Default for click/type mouse movement and key delays.                                          |
| `allowPrivateHosts`          | `true`                                 | Permit localhost and private hosts; metadata endpoints stay blocked for top-level navigation.  |
| `allowLocalFiles`            | `false`                                | Permit navigation to local files that match `localFileGlobs`.                                  |
| `localFileGlobs`             | `[]`                                   | Globs of allowed local files, relative to the working directory unless absolute.               |
| `screenshotsDir`             | `<agentDir>/browser-pilot/screenshots` | Default screenshot directory.                                                                  |
| `downloadsDir`               | `<agentDir>/browser-pilot/downloads`   | Directory for files downloaded by the browser.                                                 |
| `exportsDir`                 | `<agentDir>/browser-pilot/exports`     | Default directory for PDF, HAR, and trace exports.                                             |
| `maxReadChars`               | `50000`                                | Default `read` cap.                                                                            |
| `maxEvalChars`               | `20000`                                | Default `eval` cap.                                                                            |
| `maxSnapshotNodes`           | `200`                                  | Default snapshot node cap.                                                                     |
| `consoleBuffer`              | `200`                                  | Console entries kept per tab.                                                                  |
| `networkBuffer`              | `200`                                  | Network entries kept per tab.                                                                  |
| `args`                       | `[]`                                   | Extra Chrome command-line flags.                                                               |
| `noSandbox`                  | `false`                                | Add `--no-sandbox` for root/container environments.                                            |

Environment variables fill the binary and profile defaults when the configuration leaves them unset: `BROWSER_PILOT_EXECUTABLE_PATH`, `PUPPETEER_EXECUTABLE_PATH`, `CHROME_PATH`, and `BROWSER_PILOT_PROFILE`. An explicit `executablePath` in `browser-pilot.json` wins over the environment. Secrets stay in the environment; `type` can read a value with `text_env`.

Path values accept a leading `~`, which expands to the home directory. Relative paths in `profile`, `executablePath`, `screenshotsDir`, `downloadsDir`, `exportsDir`, `logging.dir`, `save_path`, `path`, `text_file`, `files`, `script_path`, and `localFileGlobs` resolve against the working directory.

Local file navigation is off by default. Enable it and list the files that may be opened:

```json
{
  "allowLocalFiles": true,
  "localFileGlobs": ["fixtures/**", "reports/*.html", "/srv/shared/docs/**"]
}
```

A relative glob matches files inside the working directory only; a glob that is written as an absolute path matches absolute paths. `localFileGlobs` accepts a single string as well as a list.

### Profiles

A profile is a Chrome user-data-dir. Chrome permits one process per profile.

- `shared` (default) lives at `<agentDir>/browser-pilot/profiles/shared`. It keeps cookies and logins warm across sessions.
- `session` lives at `<agentDir>/browser-pilot/profiles/sessions/<sessionId>`. It is isolated and deleted on a clean close.
- A name such as `work` lives at `<agentDir>/browser-pilot/profiles/work`.
- An absolute path is used directly.

One Chrome process serves a profile. Sessions in one pi process share it, and a second pi process attaches to the live DevTools endpoint instead of failing on the profile lock. `web_fetch` and `web_search` lease the same process and profile when their runtime settings match this tool's: their renders open short-lived pages that count toward `runtime.maxPages` but not toward the tab-per-minute windows, and their probe requests can send the profile's cookies. Sessions see only the tabs they opened: a page created by one session is invisible and unreachable from another, and the tab count of one session never closes another's page. Set `runtime.isolation: "contexts"` when a session needs its own cookies and storage rather than the shared warm jar.

`close` ends a session and closes its tabs. The browser process closes only when no other session is using it and this process started it; when another session still leases it, the call reports that the browser stays open. A process that attached to someone else's browser disconnects without closing it.

Chrome 136 and later refuse remote debugging on the default user-data-dir. Always use a dedicated profile, as this tool does.

### Logging

Logging is opt-in and writes one JSON object per call to `<agentDir>/browser-pilot/logs/browser-pilot.jsonl` by default.

| Key                            | Default                         | Effect                                                       |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------ |
| `logging.enabled`              | `false`                         | Record completed calls.                                      |
| `logging.dir`                  | `<agentDir>/browser-pilot/logs` | Directory for the JSONL file.                                |
| `logging.includeArgs`          | `true`                          | Record URLs, selectors, refs, paths, and output text.        |
| `logging.includeSensitiveArgs` | `false`                         | Record typed text, `eval` source, page content, and secrets. |
| `logging.outputs`              | `summary`                       | `none`, `summary`, `snippet`, or `full`.                     |
| `logging.maxOutputChars`       | `2000`                          | Cap for snippet/full output in a record.                     |

The record includes the shared usage envelope, the action, profile, pid, port, Chrome version, tab count, URL, title, status, challenge, truncation, saved path, safe parameters, and an output summary. Typed text, `eval` source, cookie and storage values, route bodies, and assertion values are reduced to length and SHA-256 hash by default. When `logging.includeArgs` is false, output text, URLs, titles, challenge data, and saved paths are omitted. When `logging.includeSensitiveArgs` is false, page-derived output for `read`, `eval`, `snapshot`, `console`, `network`, `expect`, and `steps` is reduced to character and line counts, and `cookies`, `storage`, and `clipboard` output is never logged. Small structured results from safe actions are logged in full; large results use a head/tail snippet when page content is explicitly enabled. Screenshots and exports record the path and metadata, not the file contents.

## Behavior and fallbacks

- **Ports.** Chrome is spawned with `--remote-debugging-port=0`. The tool reads the actual port from the profile's `DevToolsActivePort` file, so it never scans for a free port or collides with another window.
- **Reconnects.** A per-profile instance record and a per-session tab record let the tool reconnect after a reload or a closed window. Stale records are validated by pid and DevTools endpoint before reuse; a dead process is replaced on the next call.
- **Tabs.** Handles are stable integers. Tabs created by the agent are marked as owned; tabs opened by the user are left alone by cleanup. Popups, including `noopener` windows, are attached as new tabs automatically. The `maxTabs` cap applies to popups and user-opened tabs as well as `tabs new`. Tab creation is additionally limited to two per minute per session and ten per minute across sessions, so a loop cannot trip challenge services.
- **Subresource blocking.** Third-party ads, analytics, images, media, and fonts are blocked by default through request interception. First-party requests are untouched, and a host entry can opt out with `hosts.<host>.allow`. Route rules still win over the default policy. Render pages opened by the web tools apply the same policy.
- **Identity.** The browser keeps the real binary's user agent and client hints unless `userAgent` is configured; navigation and tab creation consume the same per-host politeness budget as HTTP requests (`hosts.<host>.minIntervalMs`, learned limits). The web tools share the identity because they share the process.
- **Refs.** `snapshot` clears old refs, assigns `data-pi-ref` attributes, and returns one line per visible interactive element across the main document, open shadow roots, and child frames. `selector` scopes the walk to matching subtrees; `ref` is rejected because refs come from the snapshot itself. Refs from iframes are resolved inside that frame; shadow refs use Puppeteer's piercing selector. Refs are scoped to the tab that created them. `read`, `screenshot`, and `{action:"wait", params:{until:"selector"}}` also accept refs. A navigation, a tab close, or a new snapshot invalidates the old refs.
- **Downloads.** The browser saves downloads to `downloadsDir`. `{action:"download", params:{operation:"wait"}}` waits for the newest matching file and resolves the path Chrome actually wrote, including collision suffixes. `{action:"download", params:{operation:"clear"}}` clears the history, not the files. Download capture is available for browsers launched by the tool, not for `connect` attachments.
- **Uploads.** `upload` sets one or more local files on a file input and reports the absolute paths.
- **Cookies and storage.** `cookies` uses the browser cookie store and supports URL- or domain-scoped cookies. `storage` reads and mutates `localStorage` or `sessionStorage` in the current tab. `state` exports and imports a versioned JSON bundle containing cookies plus per-origin local and session storage; bundles are written with owner-only permissions and contain session credentials. Import validates the bundle, accepts only `http(s)` origins, and applies the navigation guard before touching an origin.
- **Emulation.** `emulate` applies viewport, user agent, locale, timezone, color scheme, reduced motion, network, CPU, and geolocation overrides to the current tab. `permissions` grants or clears browser permissions for an origin. `reset:true` restores configuration defaults.
- **Clipboard.** `clipboard` reads or writes the system clipboard after granting clipboard permissions for the current origin. It requires a secure context (HTTPS or localhost). Because a background window is not a focused document, the tab is brought forward and focus emulation is enabled for the duration of the call; if access is still denied, the error names the window focus as the cause.
- **Frames.** `{action:"frames", params:{operation:"list"}}` lists child frames with indices. `{action:"frames", params:{operation:"select", frame:1}}` scopes `read`, `eval`, and element screenshots to that frame; `{action:"frames", params:{operation:"main"}}` returns to the main frame.
- **Network.** `{action:"network", params:{operation:"read"}}` returns a compact overview with stable request ids, response sizes from `Content-Length`, and duration. `{action:"network", params:{operation:"get", request_id:"r12"}}` reads headers, request data, timing phases, and a body preview from a recently retained response. `{action:"wait", params:{until:"response", url_pattern:"/api/items"}}` returns the matching request id. `har` remains the guaranteed full-fidelity capture path.
- **Assertions.** `expect` polls until the assertion passes or `timeout_ms` expires. Missing elements count as hidden, so `{action:"expect", params:{check:"hidden"}}` succeeds for absent elements. `value`, `attribute`, `visible`, `hidden`, and `count` checks require `ref` or `selector`; `attribute` also requires `attribute`.
- **Metrics and doctor.** `metrics` reports heap, DOM, navigation timing, and resource totals. `doctor` checks the binary (including that a configured path exists), profile, port, display, sandbox, writable screenshots/downloads/exports/logs/profile directories, and stale instance state.
- **Highlight.** `highlight` flashes an element outline for a short duration, which is useful when handing the window to a human.
- **Routing.** `route` installs page-level request interception rules. Matching requests can be aborted, continued, delayed, or fulfilled with a synthetic response. Rules are session-wide and apply to tabs managed when the rule is added and to new agent tabs; tabs opened by the user after a rule is added are attached without interception. Rule ids look like `rt1`. `clear` disables interception.
- **Exports.** `pdf` prints the current page, `har` records request/response metadata and response bodies up to 1 MiB per entry, and `trace` records a Chrome trace. `{action:"har", params:{operation:"stop"}}` requires an active recording; a second `{action:"har", params:{operation:"start"}}` is rejected. A trace that does not receive `tracingComplete` within 10 seconds is written with an incomplete-capture warning. Each export writes to `exportsDir` unless `path` is set.
- **External browsers.** `connect` attaches to an existing `ws://` or `http://` DevTools endpoint. Existing tabs are attached without changing their viewport, user agent, emulation, or download behavior, and `{action:"close", params:{target:"browser"}}` disconnects without closing Chrome.
- **Local files.** `open`, `navigate`, and `tabs new` accept a local file only when `allowLocalFiles` is true and the resolved path matches one of `localFileGlobs`. A bare path such as `./fixtures/page.html` is resolved against the working directory and rewritten to a `file:` URL; a `file:` URL is accepted directly. A path that does not match, a path outside the working directory matched against a relative glob, or a glob list that is empty is rejected with the reason, before Chrome navigates. The guard also covers auth-state import origins.
- **Content.** `read` uses Readability and Turndown for markdown, `innerText` for text, the live DOM for HTML, and a compact structural tree for `outline`. Inline `data:` image payloads are stripped.
- **Dialogs.** Dialogs are dismissed automatically by default. Set `{action:"dialog", params:{operation:"policy", policy:"manual"}}` to inspect and resolve them explicitly.
- **Challenges.** Cloudflare, reCAPTCHA, hCaptcha, PerimeterX, DataDome, and generic access-denied pages are detected after navigation and inspection. A blocking challenge is reported with a hint to solve it in the window and call `{action:"wait", params:{until:"human"}}`. The tool never attempts to solve a challenge.
- **History.** `{action:"navigate", params:{direction:"back"}}` and `{action:"navigate", params:{direction:"forward"}}` report a missing history entry only when the URL did not change. Same-document entries, such as those created by `history.pushState`, move the history without a network response and are reported as a normal navigation.
- **Key combinations.** `press` splits `Control+A`-style combinations into held modifiers (`Control`, `Shift`, `Alt`, `Meta`, and the aliases `Ctrl`, `Cmd`, `Command`, `Option`) and a base key. Unknown modifiers and keys are rejected with a hint.
- **Option matching.** `select` matches each requested value against option values first, then option labels, then visible text. Requests that match nothing are reported; a call where nothing matches fails and lists the available options.
- **Errors.** Errors carry the action in structured details, name the current tab and URL when available, and include a next-step hint where one is known. Ref errors suggest a new snapshot; tab errors suggest a tab list; profile errors name the owning process.
- **Logging.** Opt-in JSONL records are written to `<agentDir>/browser-pilot/logs/browser-pilot.jsonl`. See the root README for the shared logging keys.

## Limitations

- CAPTCHAs and bot challenges are detected and handed to a human. They are not solved automatically.
- The tool uses a real Chrome window. On a host without a display, `headless:"auto"` falls back to new headless, which removes the human handoff path.
- A profile is single-instance. Sessions in this process share the browser and other pi processes attach to it; use `profile:"session"` or different named profiles when unrelated work must not share cookies. A process launched headless by `runtime.headless: true` stays headless, so its pages cannot be handed to a human.
- `snapshot` covers open shadow roots and child frames. Closed shadow roots are not accessible.
- HAR response bodies are capped at 1 MiB per entry; larger bodies and streaming responses may be incomplete. Traces and HAR files can be large on long or busy pages.
- `{action:"network", params:{operation:"get"}}` reads bodies from a bounded set of recently retained responses. A body can be unavailable after navigation, buffer eviction, or for streaming/binary responses; use `har` when the body must be captured reliably.
- `state` exports storage for origins that are open in managed tabs at export time. Cookies are exported from the whole browser cookie store. Import accepts only `http(s)` origins and blocks metadata hosts.
- `clipboard` requires a secure context (HTTPS or localhost) and a browser that permits clipboard access. `permissions` is browser-context-wide for the origin. A window that never gets focus, such as a fully backgrounded one on some window managers, can still be refused by the browser.
- `annotate` draws boxes for refs in the main document and open shadow roots. Refs inside iframes are not annotated.
- Local files are only reachable when `allowLocalFiles` is enabled and the path matches `localFileGlobs`; every other `file:` navigation is blocked before Chrome sees it. Chrome still applies its own file-origin rules, so a page opened from disk cannot fetch sibling files or `file:` URLs through `fetch` or `XMLHttpRequest` unless Chrome is started with `--allow-file-access-from-files` (add it to `args`). Pages opened from disk can read their own embedded content, and `eval` and `read` work as usual.
- The navigation guard checks top-level navigations. Redirects and subresource requests are not re-checked, and metadata hostnames are blocked by name and known address spelling for the initial navigation only.
- `metrics` reflects the current page and the most recent navigation timing entry; it is not a profiler. Use `trace` for detailed performance work.
- `doctor` reports common environment problems but cannot detect every OS-specific Chrome failure.
- Request interception is page-level and applies to the browser tabs this session manages. Service-worker or browser-process requests may bypass it.
- `pdf` depends on Chrome's print pipeline and may fail in some headless or headful configurations.
- `eval` runs arbitrary JavaScript in the page. It can read cookies and page storage and can make requests on the page's behalf. Treat page output as untrusted data.
- `type` values, `eval` source, cookie and storage values, page content, and network/console output are not written to usage logs by default; only lengths and hashes are recorded. Enabling `logging.includeSensitiveArgs` changes that. URLs, titles, challenge data, saved paths, and output text are omitted when `logging.includeArgs` is false.
- Download capture is unavailable for `connect` attachments because the tool does not change an external browser's download behavior. `noopener` popups are attached as user tabs and are not closed by tab cleanup.
- Public sites may still block automated browsers. The tool reports the challenge instead of retrying indefinitely.

## License and provenance

Original code is MIT; see [LICENSE](../../LICENSE). The content pipeline reuses the Readability and Turndown helpers shared with `web_fetch`, which are adapted from `oh-my-pi` (MIT); see [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). The browser is driven through `puppeteer-core`.
