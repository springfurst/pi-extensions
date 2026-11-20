import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "./__fixtures__/clock";
import { HttpCache } from "./cache";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "web-cache-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const entry = {
  url: "https://example.com/",
  etag: '"v1"',
  contentType: "text/html",
  body: "<html>hello</html>",
};

describe("HttpCache", () => {
  it("round-trips an entry through disk", () => {
    const dir = tempDir();
    const clock = new FakeClock();
    const first = new HttpCache({ dir, clock });
    expect(first.store("key", entry)).toBe(true);
    first.store("other", { ...entry, etag: '"v2"' });

    const second = new HttpCache({ dir, clock });
    expect(second.lookup("key")).toMatchObject(entry);
    expect(second.lookup("other")?.etag).toBe('"v2"');
    expect(second.lookup("missing")).toBeUndefined();
  });

  it("refuses entries without a validator", () => {
    const cache = new HttpCache({ dir: tempDir() });
    expect(cache.store("key", { url: entry.url, contentType: "text/plain", body: "x" })).toBe(
      false,
    );
    expect(cache.lookup("key")).toBeUndefined();
  });

  it("refuses bodies over the size cap", () => {
    const cache = new HttpCache({ dir: tempDir(), maxBodyBytes: 8 });
    expect(cache.store("key", { ...entry, body: "0123456789" })).toBe(false);
    expect(cache.store("small", { ...entry, body: "0123456" })).toBe(true);
  });

  it("expires entries after the ttl", () => {
    const clock = new FakeClock();
    const cache = new HttpCache({ dir: tempDir(), clock, ttlMs: 1_000 });
    cache.store("key", entry);
    clock.advanceBy(1_500);
    expect(cache.lookup("key")).toBeUndefined();
  });

  it("keeps variants of one URL apart", () => {
    const cache = new HttpCache({ dir: tempDir() });
    cache.store("url\ntext/html", { ...entry, body: "html" });
    cache.store("url\ntext/markdown", { ...entry, body: "markdown" });
    expect(cache.lookup("url\ntext/html")?.body).toBe("html");
    expect(cache.lookup("url\ntext/markdown")?.body).toBe("markdown");
  });

  it("deletes one variant and clears the rest", () => {
    const dir = tempDir();
    const clock = new FakeClock();
    const cache = new HttpCache({ dir, clock });
    cache.store("one", entry);
    cache.store("two", entry);
    cache.delete("one");
    expect(cache.lookup("one")).toBeUndefined();
    cache.clear();
    expect(cache.lookup("two")).toBeUndefined();
    expect(readdirSync(join(dir, "http"))).toEqual([]);
  });

  it("ignores a malformed entry file", () => {
    const dir = tempDir();
    const cache = new HttpCache({ dir });
    cache.store("key", entry);
    const files = readdirSync(join(dir, "http"));
    writeFileSync(join(dir, "http", files[0]!), "{ oops");
    const reloaded = new HttpCache({ dir });
    expect(reloaded.lookup("key")).toBeUndefined();
  });

  it("ignores an entry written for another key", () => {
    const dir = tempDir();
    const clock = new FakeClock();
    const cache = new HttpCache({ dir, clock });
    cache.store("key", entry);
    const files = readdirSync(join(dir, "http"));
    writeFileSync(
      join(dir, "http", files[0]!),
      JSON.stringify({ schema: 1, key: "different", ...entry, storedAt: clock.now() }),
    );
    const reloaded = new HttpCache({ dir, clock });
    expect(reloaded.lookup("key")).toBeUndefined();
  });

  it("leaves no temporary file behind", () => {
    const dir = tempDir();
    const cache = new HttpCache({ dir });
    cache.store("key", entry);
    expect(readdirSync(join(dir, "http")).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(existsSync(join(dir, "http"))).toBe(true);
  });

  it("does not throw when the cache directory is unusable", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "http"), { recursive: true });
    // A directory where the entry file belongs makes the write fail.
    const cache = new HttpCache({ dir });
    cache.store("key", entry);
    const files = readdirSync(join(dir, "http"));
    rmSync(join(dir, "http", files[0]!), { force: true });
    mkdirSync(join(dir, "http", files[0]!));
    const other = new HttpCache({ dir });
    expect(() => other.store("key", entry)).not.toThrow();
  });
});
