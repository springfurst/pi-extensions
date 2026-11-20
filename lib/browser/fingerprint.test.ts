import { describe, expect, it } from "vitest";
import { chromeVersionOf, fingerprintFor, navigationHeaders } from "./fingerprint";

describe("chromeVersionOf", () => {
  it("reads a full version from a browser string", () => {
    expect(chromeVersionOf("HeadlessChrome/140.0.7339.80")).toEqual({
      major: "140",
      full: "140.0.7339.80",
    });
  });

  it("accepts a bare major version", () => {
    expect(chromeVersionOf("140")).toEqual({ major: "140", full: "140.0.0.0" });
  });

  it("rejects a string without a version", () => {
    expect(chromeVersionOf("Chrome")).toBeUndefined();
  });
});

describe("fingerprintFor", () => {
  it("derives a Windows user agent and matching client hints", () => {
    const fingerprint = fingerprintFor("Chrome/140.0.7339.80", "win32", "x64");
    expect(fingerprint.userAgent).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.80 Safari/537.36",
    );
    expect(fingerprint.metadata).toMatchObject({
      fullVersion: "140.0.7339.80",
      platform: "Windows",
      architecture: "x86",
      mobile: false,
    });
    expect(fingerprint.metadata.brands).toContainEqual({ brand: "Google Chrome", version: "140" });
  });

  it("derives a macOS fingerprint on arm", () => {
    const fingerprint = fingerprintFor("Chrome/139.0.1.2", "darwin", "arm64");
    expect(fingerprint.userAgent).toContain("Macintosh; Intel Mac OS X 10_15_7");
    expect(fingerprint.metadata.platform).toBe("macOS");
    expect(fingerprint.metadata.architecture).toBe("arm");
  });

  it("derives a Linux fingerprint for other platforms", () => {
    const fingerprint = fingerprintFor("Chrome/140.0.0.0", "linux", "arm64");
    expect(fingerprint.userAgent).toContain("X11; Linux x86_64");
    expect(fingerprint.metadata.platform).toBe("Linux");
  });

  it("falls back to a recent version when the browser did not report one", () => {
    const fingerprint = fingerprintFor("");
    expect(fingerprint.major).toBe("131");
    expect(fingerprint.userAgent).toContain("Chrome/131.0.0.0");
  });
});

describe("navigationHeaders", () => {
  it("keeps the user agent and every client hint on one identity", () => {
    const fingerprint = fingerprintFor("Chrome/140.0.7339.80", "win32", "x64");
    const headers = navigationHeaders(fingerprint);
    expect(headers["User-Agent"]).toBe(fingerprint.userAgent);
    expect(headers["Sec-Ch-Ua"]).toContain('"Google Chrome";v="140"');
    expect(headers["Sec-Ch-Ua"]).toContain('"Chromium";v="140"');
    expect(headers["Sec-Ch-Ua-Platform"]).toBe('"Windows"');
    expect(headers["Sec-Ch-Ua-Mobile"]).toBe("?0");
    expect(headers["Sec-Fetch-Mode"]).toBe("navigate");
  });

  it("does not leak one caller's mutation into the next", () => {
    const fingerprint = fingerprintFor("Chrome/140.0.0.0", "linux", "x64");
    const first = navigationHeaders(fingerprint);
    first["User-Agent"] = "mutated";
    expect(navigationHeaders(fingerprint)["User-Agent"]).toBe(fingerprint.userAgent);
  });
});
