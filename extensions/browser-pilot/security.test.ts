import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { checkNavigationAllowed, isMetadataHost, matchesLocalGlobs } from "./security";

const privateHosts = { allowPrivateHosts: true };
const publicOnly = { allowPrivateHosts: false };

describe("checkNavigationAllowed", () => {
  it("allows localhost when private hosts are enabled", async () => {
    await expect(
      checkNavigationAllowed("http://127.0.0.1:3000/", privateHosts),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      checkNavigationAllowed("http://localhost:3000/", privateHosts),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("blocks private hosts when private hosts are disabled", async () => {
    await expect(
      checkNavigationAllowed("http://127.0.0.1:3000/", publicOnly),
    ).resolves.toMatchObject({ allowed: false });
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
      await expect(checkNavigationAllowed(url, privateHosts), url).resolves.toMatchObject({
        allowed: false,
      });
    }
  });

  it("allows the internal blank page", async () => {
    await expect(checkNavigationAllowed("about:blank", privateHosts)).resolves.toEqual({
      allowed: true,
      url: "about:blank",
    });
  });

  it("rejects other schemes", async () => {
    await expect(
      checkNavigationAllowed("javascript:alert(1)", privateHosts),
    ).resolves.toMatchObject({
      allowed: false,
    });
    await expect(
      checkNavigationAllowed("data:text/html,<h1>x</h1>", privateHosts),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("returns the parsed URL for an allowed navigation", async () => {
    await expect(
      checkNavigationAllowed("https://example.com/a?b=1", privateHosts),
    ).resolves.toEqual({
      allowed: true,
      url: "https://example.com/a?b=1",
    });
  });

  it("rejects a bare word that is neither a URL nor an existing file", async () => {
    await expect(checkNavigationAllowed("example.com", privateHosts)).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("Invalid URL"),
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

describe("local file navigation", () => {
  function workspace(): { cwd: string; page: string; outside: string } {
    const cwd = mkdtempSync(join(tmpdir(), "browser-pilot-local-"));
    mkdirSync(join(cwd, "fixtures"), { recursive: true });
    const page = join(cwd, "fixtures", "page.html");
    writeFileSync(page, "<!doctype html><title>Local</title>");
    const outside = join(cwd, "..", `outside-${Date.now()}.html`);
    writeFileSync(outside, "<!doctype html><title>Outside</title>");
    return { cwd, page, outside };
  }

  it("blocks every local file by default", async () => {
    const { cwd, page } = workspace();
    await expect(
      checkNavigationAllowed(page, { allowPrivateHosts: true, cwd }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("Local file navigation is disabled"),
    });
  });

  it("blocks a file URL by default", async () => {
    const { cwd, page } = workspace();
    await expect(
      checkNavigationAllowed(pathToFileURL(page).href, { allowPrivateHosts: true, cwd }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("opens a matching file from a relative path and from a file URL", async () => {
    const { cwd, page } = workspace();
    const options = {
      allowPrivateHosts: true,
      allowLocalFiles: true,
      localFileGlobs: ["fixtures/**"],
      cwd,
    };
    const expected = pathToFileURL(page).href;
    await expect(checkNavigationAllowed("./fixtures/page.html", options)).resolves.toEqual({
      allowed: true,
      url: expected,
    });
    await expect(checkNavigationAllowed(expected, options)).resolves.toEqual({
      allowed: true,
      url: expected,
    });
  });

  it("blocks a path outside the configured globs", async () => {
    const { cwd, outside } = workspace();
    await expect(
      checkNavigationAllowed(outside, {
        allowPrivateHosts: true,
        allowLocalFiles: true,
        localFileGlobs: ["fixtures/**"],
        cwd,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("does not match localFileGlobs"),
    });
  });

  it("blocks everything when local files are enabled without globs", async () => {
    const { cwd, page } = workspace();
    await expect(
      checkNavigationAllowed(page, {
        allowPrivateHosts: true,
        allowLocalFiles: true,
        localFileGlobs: [],
        cwd,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("No localFileGlobs"),
    });
  });

  it("does not let a parent glob escape the working directory", async () => {
    const { cwd, outside } = workspace();
    await expect(
      checkNavigationAllowed(outside, {
        allowPrivateHosts: true,
        allowLocalFiles: true,
        localFileGlobs: ["**"],
        cwd,
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("matches absolute globs", () => {
    const { cwd, page } = workspace();
    expect(matchesLocalGlobs(page, [join(cwd, "fixtures", "*.html")], cwd)).toBe(true);
    expect(matchesLocalGlobs(page, [join(cwd, "other", "*.html")], cwd)).toBe(false);
  });
});
