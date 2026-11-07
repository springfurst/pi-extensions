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
    await expect(
      checkNavigationAllowed("http://169.254.169.254/latest/meta-data/", true),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      checkNavigationAllowed("http://metadata.google.internal/computeMetadata/v1/", true),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("rejects non-http schemes", async () => {
    await expect(checkNavigationAllowed("file:///etc/passwd", true)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(checkNavigationAllowed("javascript:alert(1)", true)).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("identifies metadata hosts", () => {
    expect(isMetadataHost("metadata.google.internal")).toBe(true);
    expect(isMetadataHost("example.com")).toBe(false);
  });
});
