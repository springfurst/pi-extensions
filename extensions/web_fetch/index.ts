import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import { renderFetchCall, renderFetchResult } from "./render";
import { executeWebFetch } from "./tool";

const FetchParams = Type.Object({
  url: Type.String({
    description:
      "Absolute http(s) URL to read. May end with a line selector: :N, :N-M, :N+M, :A-B,C-D, :-N (last N lines), :raw, or a range combined with raw.",
  }),
  raw: Type.Optional(
    Type.Boolean({ description: "Return the response body verbatim, skipping text shaping." }),
  ),
  max_chars: Type.Optional(
    Type.Number({ description: "Per-call output cap in characters; overrides fetch.maxChars." }),
  ),
  save_path: Type.Optional(
    Type.String({
      description:
        "Write the full rendered content to this file (relative paths resolve against the working directory), so long output can be grep'd.",
    }),
  ),
});

export default function webFetchExtension(pi: ExtensionAPI) {
  const webFetchTool = defineTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and return readable text. HTML is rendered to markdown, JSON is pretty-printed, RSS/Atom is converted to markdown, and markdown/llms.txt alternates are preferred when the site provides them. Append a selector to read part of a long document.",
    promptSnippet: "Fetch and read a web page as text",
    promptGuidelines: [
      "Use web_fetch to read a known URL; use web_search to discover URLs first.",
      "Append a line selector such as :100-200 to read a slice of long output.",
    ],
    parameters: FetchParams,
    annotations: { readOnlyHint: true, openWorldHint: true },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeWebFetch(params, {
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        trusted: ctx.isProjectTrusted(),
        signal,
        cacheDir: join(getAgentDir(), "web-tools"),
        exec: (command, args, options) => pi.exec(command, args, options),
      });
    },

    renderCall: (args, theme) => renderFetchCall(args, theme),
    renderResult: (result, options, theme) => renderFetchResult(result, options, theme),
  });

  pi.registerTool(webFetchTool);
}
