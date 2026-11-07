import { describe, expect, it } from "vitest";
import { validateStorageBundle } from "./state";
import { BrowserPilotError } from "./types";

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    cookies: [{ name: "token", value: "secret", domain: "example.com", path: "/" }],
    origins: [
      {
        origin: "https://example.com",
        localStorage: { theme: "dark" },
        sessionStorage: { tab: "1" },
      },
    ],
    ...overrides,
  };
}

describe("validateStorageBundle", () => {
  it("accepts a valid version 1 bundle", () => {
    const result = validateStorageBundle(bundle());
    expect(result.origins[0]).toMatchObject({
      origin: "https://example.com",
      localStorage: { theme: "dark" },
    });
  });

  it("rejects non-objects and unknown versions", () => {
    expect(() => validateStorageBundle(null)).toThrow(BrowserPilotError);
    expect(() => validateStorageBundle("nope")).toThrow(BrowserPilotError);
    expect(() => validateStorageBundle(bundle({ version: 2 }))).toThrow(/unsupported format/);
  });

  it("rejects invalid cookies", () => {
    expect(() => validateStorageBundle(bundle({ cookies: [{ name: "x" }] }))).toThrow(
      /invalid cookie/,
    );
  });

  it("rejects non-http(s) and malformed origins", () => {
    expect(() =>
      validateStorageBundle(
        bundle({
          origins: [{ origin: "file:///etc/passwd", localStorage: {}, sessionStorage: {} }],
        }),
      ),
    ).toThrow(/must be http/);
    expect(() =>
      validateStorageBundle(
        bundle({
          origins: [{ origin: "not a url", localStorage: {}, sessionStorage: {} }],
        }),
      ),
    ).toThrow(/invalid origin/);
  });

  it("rejects non-string storage values", () => {
    expect(() =>
      validateStorageBundle(
        bundle({
          origins: [
            {
              origin: "https://example.com",
              localStorage: { count: 1 },
              sessionStorage: {},
            },
          ],
        }),
      ),
    ).toThrow(/invalid storage values/);
  });
});
