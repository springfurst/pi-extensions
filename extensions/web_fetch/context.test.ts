import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../lib/config";
import { createFetchContext } from "./context";

describe("createFetchContext", () => {
  it("bounds the whole call with a wall-clock deadline", async () => {
    const ctx = createFetchContext({
      config: { ...DEFAULT_CONFIG.fetch, timeoutSeconds: 0.05, allowPrivateHosts: true },
    });
    expect(ctx.signal?.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ctx.signal?.aborted).toBe(true);
    await expect(ctx.loadPage("https://example.com/")).rejects.toThrow();
  });

  it("aborts when the caller signal aborts", () => {
    const controller = new AbortController();
    const ctx = createFetchContext({
      config: DEFAULT_CONFIG.fetch,
      signal: controller.signal,
    });
    controller.abort();
    expect(ctx.signal?.aborted).toBe(true);
  });
});
