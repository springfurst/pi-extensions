import { describe, expect, it } from "vitest";
import { cookieHeaderFor } from "./cookies";

describe("cookieHeaderFor", () => {
  it("joins the jar into one header", async () => {
    const header = await cookieHeaderFor(
      {
        cookies: async () => [
          { name: "session", value: "abc" },
          { name: "theme", value: "dark" },
        ],
      },
      "https://example.com/",
    );
    expect(header).toBe("session=abc; theme=dark");
  });

  it("returns undefined for an empty jar", async () => {
    expect(
      await cookieHeaderFor({ cookies: async () => [] }, "https://example.com/"),
    ).toBeUndefined();
  });

  it("skips nameless cookies", async () => {
    const header = await cookieHeaderFor(
      {
        cookies: async () => [
          { name: "", value: "junk" },
          { name: "ok", value: "1" },
        ],
      },
      "https://example.com/",
    );
    expect(header).toBe("ok=1");
  });

  it("swallows a jar that cannot answer", async () => {
    const header = await cookieHeaderFor(
      {
        cookies: async () => {
          throw new Error("closed");
        },
      },
      "https://example.com/",
    );
    expect(header).toBeUndefined();
  });
});
