import { describe, expect, it } from "vitest";
import { checkNavigationAllowed, isMetadataHost } from "./security";

describe("checkNavigationAllowed", () => {
  it("allows localhost when private hosts are enabled", async () => {
    await expect(checkNavigationAllowed("http://127.0.0.1:3000/", true)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(checkNavigationAllowed("http://localhost:3000/", true)).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("blocks private hosts when private hosts are disabled", async () => {
    await expect(checkNavigationAllowed("http://127.0.0.1:3000/", false)).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("always blocks cloud metadata endpoints", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.169.254./latest/meta-data/",
      "http://2852039166/latest/meta-data/",
      "http://0xa9fea9fe/latest/meta-data/",
      "http://0251.0376.0251.0376/latest/meta-data/",
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://169.254.170.2/v2/credentials",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://metadata.google.internal./computeMetadata/v1/",
      "http://[fd00:ec2::254]/latest/meta-data/",
    ]) {
      await expect(checkNavigationAllowed(url, true), url).resolves.toMatchObject({
        allowed: false,
      });
    }
  });

  it("rejects non-http schemes", async () => {
    await expect(checkNavigationAllowed("file:///etc/passwd", true)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(checkNavigationAllowed("javascript:alert(1)", true)).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("identifies metadata hosts and alternate spellings", () => {
    expect(isMetadataHost("metadata.google.internal")).toBe(true);
    expect(isMetadataHost("metadata.google.internal.")).toBe(true);
    expect(isMetadataHost("2852039166")).toBe(true);
    expect(isMetadataHost("::ffff:a9fe:a9fe")).toBe(true);
    expect(isMetadataHost("example.com")).toBe(false);
    expect(isMetadataHost("8.8.8.8")).toBe(false);
  });
});
