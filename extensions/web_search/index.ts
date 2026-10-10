import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderSearchCall, renderSearchResult } from "./render";
import { executeWebSearch } from "./tool";

const SearchParams = Type.Object({
  query: Type.String({
    description:
      'Search query. Supports Google-style directives: site:, -site:, after:/before: YYYY-MM-DD, inurl:, intitle:, filetype:, "quoted phrases", -exclusions, and OR.',
  }),
  recency: Type.Optional(
    Type.Union(
      [Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")],
      { description: "Restrict results to the given time window." },
    ),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results." })),
});

const StructuredSource = Type.Object({
  title: Type.String(),
  url: Type.String(),
  snippet: Type.Optional(Type.String()),
});

export default function webSearchExtension(pi: ExtensionAPI) {
  const webSearchTool = defineTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for up-to-date information and return sources with titles, URLs, and snippets. Prefer primary sources and cite the URLs you use.",
    promptSnippet: "Search the web for up-to-date information",
    promptGuidelines: [
      "Use web_search to discover URLs, then web_fetch to read a result in full.",
      "Prefer primary sources and cite the URLs you use.",
    ],
    parameters: SearchParams,
    outputSchema: Type.Array(StructuredSource),
    annotations: { readOnlyHint: true, openWorldHint: true },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeWebSearch(params, {
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        trusted: ctx.isProjectTrusted(),
        signal,
      });
    },

    renderCall: (args, theme) => renderSearchCall(args, theme),
    renderResult: (result, options, theme) => renderSearchResult(result, options, theme),
  });

  pi.registerTool(webSearchTool);
}
