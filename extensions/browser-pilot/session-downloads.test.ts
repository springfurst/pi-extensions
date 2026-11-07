import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDownloadedFile } from "./session-downloads";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "browser-pilot-download-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveDownloadedFile", () => {
  it("returns the predicted path when it exists", () => {
    const dir = tempDir();
    const path = join(dir, "sample.txt");
    writeFileSync(path, "data");
    expect(resolveDownloadedFile(dir, path)).toBe(path);
  });

  it("finds a renamed collision file", () => {
    const dir = tempDir();
    const actual = join(dir, "sample (1).txt");
    writeFileSync(actual, "data");
    expect(resolveDownloadedFile(dir, join(dir, "sample.txt"))).toBe(actual);
  });

  it("falls back to the predicted path when nothing matches", () => {
    const dir = tempDir();
    const predicted = join(dir, "sample.txt");
    expect(resolveDownloadedFile(dir, predicted)).toBe(predicted);
  });
});
