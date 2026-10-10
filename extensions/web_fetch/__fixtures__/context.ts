import { DEFAULT_CONFIG } from "../../../lib/config";
import { createFetchContext } from "../context";
import type { FetchContext } from "../types";

export type FixtureHandler = (
  url: string,
  init?: RequestInit,
) => Response | undefined | Promise<Response | undefined>;

/** Build a fetch context whose transport is a fixture handler and whose DNS is stubbed public. */
export function fixtureContext(handler: FixtureHandler): FetchContext {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const response = await handler(url, init);
    return response ?? new Response("not found", { status: 404 });
  };
  return createFetchContext({
    config: {
      ...DEFAULT_CONFIG.fetch,
      allowPrivateHosts: true,
      externalReaders: false,
      remoteFallbacks: false,
    },
    fetch: fetchImpl,
    resolve: async () => ["93.184.216.34"],
  });
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function textResponse(value: string, contentType = "text/plain"): Response {
  return new Response(value, { status: 200, headers: { "Content-Type": contentType } });
}
