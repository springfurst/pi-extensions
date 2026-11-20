import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCKING, blockingEnabled, sameSite, shouldBlockRequest } from "./blocking";

const page = "https://docs.example.com/guide";

describe("sameSite", () => {
  it("treats the exact host and its subdomains as first-party", () => {
    expect(sameSite("docs.example.com", "docs.example.com")).toBe(true);
    expect(sameSite("cdn.docs.example.com", "docs.example.com")).toBe(true);
    expect(sameSite("example.com", "docs.example.com")).toBe(true);
  });

  it("treats a different registrable domain as third-party", () => {
    expect(sameSite("tracker.test", "docs.example.com")).toBe(false);
    expect(sameSite("example.net", "docs.example.com")).toBe(false);
  });

  it("falls back to the last two labels without a suffix list", () => {
    expect(sameSite("www.example.co.uk", "shop.example.co.uk")).toBe(true);
  });
});

describe("shouldBlockRequest", () => {
  it("blocks third-party images, media, and fonts", () => {
    expect(
      shouldBlockRequest({
        url: "https://cdn.test/a.png",
        documentUrl: page,
        resourceType: "image",
      }),
    ).toBe("images");
    expect(
      shouldBlockRequest({
        url: "https://cdn.test/a.mp4",
        documentUrl: page,
        resourceType: "media",
      }),
    ).toBe("media");
    expect(
      shouldBlockRequest({
        url: "https://cdn.test/a.woff2",
        documentUrl: page,
        resourceType: "font",
      }),
    ).toBe("fonts");
  });

  it("leaves first-party subresources alone", () => {
    expect(
      shouldBlockRequest({
        url: "https://docs.example.com/a.png",
        documentUrl: page,
        resourceType: "image",
      }),
    ).toBeUndefined();
    expect(
      shouldBlockRequest({
        url: "https://cdn.docs.example.com/a.woff2",
        documentUrl: page,
        resourceType: "font",
      }),
    ).toBeUndefined();
  });

  it("blocks known ad and analytics hosts", () => {
    expect(
      shouldBlockRequest({
        url: "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
        documentUrl: page,
        resourceType: "script",
      }),
    ).toBe("ads");
    expect(
      shouldBlockRequest({
        url: "https://www.google-analytics.com/collect",
        documentUrl: page,
        resourceType: "fetch",
      }),
    ).toBe("analytics");
  });

  it("does not block scripts from unknown third parties", () => {
    expect(
      shouldBlockRequest({
        url: "https://cdnjs.cloudflare.com/lib.js",
        documentUrl: page,
        resourceType: "script",
      }),
    ).toBeUndefined();
  });

  it("does not block a document navigation", () => {
    expect(
      shouldBlockRequest({ url: "https://other.test/", resourceType: "document" }),
    ).toBeUndefined();
  });

  it("skips a category configured off", () => {
    expect(
      shouldBlockRequest(
        { url: "https://cdn.test/a.png", documentUrl: page, resourceType: "image" },
        { ...DEFAULT_BLOCKING, images: "off" },
      ),
    ).toBeUndefined();
  });

  it("honors a per-host allow list", () => {
    expect(
      shouldBlockRequest(
        { url: "https://cdn.test/a.png", documentUrl: page, resourceType: "image" },
        DEFAULT_BLOCKING,
        { allow: ["images"] },
      ),
    ).toBeUndefined();
  });

  it("ignores an unparseable request URL", () => {
    expect(shouldBlockRequest({ url: "not a url", resourceType: "image" })).toBeUndefined();
  });

  it("reports whether any category is active", () => {
    expect(blockingEnabled()).toBe(true);
    expect(
      blockingEnabled({ ads: "off", analytics: "off", images: "off", media: "off", fonts: "off" }),
    ).toBe(false);
  });
});
