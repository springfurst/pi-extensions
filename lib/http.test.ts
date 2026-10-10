import { describe, expect, it } from "vitest";
import { normalizeMime, readLimitedText, withHardTimeout } from "./http";

describe("withHardTimeout", () => {
  it("aborts after the deadline", async () => {
    const signal = withHardTimeout(undefined, 20);
    expect(signal.aborted).toBe(false);
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    expect(signal.aborted).toBe(true);
  });

  it("is already aborted when the caller signal is", () => {
    const signal = withHardTimeout(AbortSignal.abort(), 1000);
    expect(signal.aborted).toBe(true);
  });
});

describe("readLimitedText", () => {
  it("reads a short body whole", async () => {
    const result = await readLimitedText(new Response("hello world"), 1024);
    expect(result.text).toBe("hello world");
    expect(result.truncated).toBe(false);
    expect(result.bytes).toBe(11);
  });

  it("cuts a body at the byte cap", async () => {
    const result = await readLimitedText(new Response("hello world"), 5);
    expect(result.text).toBe("hello");
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(5);
  });

  it("handles an empty body", async () => {
    const result = await readLimitedText(new Response(null), 10);
    expect(result).toEqual({ text: "", truncated: false, bytes: 0 });
  });
});

describe("normalizeMime", () => {
  it("lowercases and strips parameters", () => {
    expect(normalizeMime("Text/HTML; charset=UTF-8")).toBe("text/html");
  });
});
