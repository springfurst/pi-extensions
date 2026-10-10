import { describe, expect, it } from "vitest";
import { fixtureContext, jsonResponse, textResponse } from "../__fixtures__/context";
import { handleCratesIo } from "./crates-io";
import { handleNpm } from "./npm";
import { handlePyPI } from "./pypi";

describe("handleNpm", () => {
  it("returns null for other hosts", async () => {
    const ctx = fixtureContext(() => undefined);
    expect(await handleNpm("https://example.com/package/x", ctx)).toBeNull();
  });

  it("renders package metadata", async () => {
    const ctx = fixtureContext((url) => {
      if (url === "https://registry.npmjs.org/left-pad/latest") {
        return jsonResponse({
          name: "left-pad",
          version: "1.3.0",
          description: "String padding",
          license: "MIT",
          repository: { url: "git+https://github.com/left-pad/left-pad.git" },
          dependencies: { foo: "^1.0.0" },
          readme: "# left-pad",
        });
      }
      if (url === "https://api.npmjs.org/downloads/point/last-week/left-pad") {
        return jsonResponse({ downloads: 123456 });
      }
      return undefined;
    });
    const result = await handleNpm("https://www.npmjs.com/package/left-pad", ctx);
    expect(result?.method).toBe("npm");
    expect(result?.content).toContain("left-pad");
    expect(result?.content).toContain("Weekly Downloads");
    expect(result?.content).toContain("## Dependencies");
  });
});

describe("handlePyPI", () => {
  it("renders package metadata", async () => {
    const ctx = fixtureContext((url) => {
      if (url === "https://pypi.org/pypi/requests/json") {
        return jsonResponse({
          info: {
            name: "requests",
            version: "2.31.0",
            summary: "HTTP for Humans",
            license: "Apache-2.0",
            author: "Kenneth",
            project_urls: { Homepage: "https://requests.readthedocs.io" },
          },
          requires_dist: ["urllib3>=1.21.1"],
        });
      }
      if (url === "https://pypistats.org/api/packages/requests/recent") {
        return jsonResponse({ data: { last_week: 5000000 } });
      }
      return undefined;
    });
    const result = await handlePyPI("https://pypi.org/project/requests/", ctx);
    expect(result?.method).toBe("pypi");
    expect(result?.content).toContain("requests");
    expect(result?.content).toContain("HTTP for Humans");
    expect(result?.content).toContain("urllib3>=1.21.1");
  });
});

describe("handleCratesIo", () => {
  it("renders crate metadata and README", async () => {
    const ctx = fixtureContext((url) => {
      if (url === "https://crates.io/api/v1/crates/serde") {
        return jsonResponse({
          crate: {
            name: "serde",
            description: "Serialization framework",
            downloads: 1000000,
            recent_downloads: 5000,
            max_version: "1.0.0",
            repository: "https://github.com/serde-rs/serde",
            homepage: null,
            documentation: null,
            categories: ["encoding"],
            keywords: ["serde"],
          },
          versions: [
            {
              num: "1.0.0",
              downloads: 100,
              created_at: "2024-01-01T00:00:00Z",
              license: "MIT",
              rust_version: null,
            },
          ],
        });
      }
      if (url === "https://docs.rs/crate/serde/1.0.0/source/README.md") {
        return textResponse(`# Serde\n\n${"content ".repeat(30)}`, "text/markdown");
      }
      return undefined;
    });
    const result = await handleCratesIo("https://crates.io/crates/serde", ctx);
    expect(result?.method).toBe("crates.io");
    expect(result?.content).toContain("serde");
    expect(result?.content).toContain("## README");
  });
});
