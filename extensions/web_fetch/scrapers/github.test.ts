import { describe, expect, it } from "vitest";
import { fixtureContext, jsonResponse, textResponse } from "../__fixtures__/context";
import { handleGitHub, parseGitHubUrl, stripActionsLogTimestamps } from "./github";

describe("parseGitHubUrl", () => {
  it("classifies repo, blob, issue, and actions URLs", () => {
    expect(parseGitHubUrl("https://github.com/facebook/react")).toEqual({
      type: "repo",
      owner: "facebook",
      repo: "react",
    });
    expect(parseGitHubUrl("https://github.com/facebook/react/blob/main/README.md")).toEqual({
      type: "blob",
      owner: "facebook",
      repo: "react",
      ref: "main",
      path: "README.md",
    });
    expect(parseGitHubUrl("https://github.com/o/r/issues/42")).toEqual({
      type: "issue",
      owner: "o",
      repo: "r",
      number: 42,
    });
    expect(
      parseGitHubUrl("https://github.com/o/r/actions/runs/27070071296/job/79897931171"),
    ).toEqual({
      type: "actions-job",
      owner: "o",
      repo: "r",
      runId: 27070071296,
      jobId: 79897931171,
    });
    expect(parseGitHubUrl("https://gitlab.com/o/r")).toBeNull();
  });
});

describe("stripActionsLogTimestamps", () => {
  it("removes the per-line timestamp and a leading BOM", () => {
    const raw = "\uFEFF2026-06-06T18:14:12.8793443Z first\n2026-06-06T18:14:13.0000000Z second\n";
    expect(stripActionsLogTimestamps(raw)).toBe("first\nsecond\n");
  });
});

describe("handleGitHub", () => {
  it("returns null for non-GitHub URLs", async () => {
    const ctx = fixtureContext(() => undefined);
    expect(await handleGitHub("https://example.com", ctx)).toBeNull();
  });

  it("renders a repository with tree and README", async () => {
    const ctx = fixtureContext((url) => {
      if (url === "https://api.github.com/repos/facebook/react") {
        return jsonResponse({
          full_name: "facebook/react",
          description: "A library",
          stargazers_count: 100,
          forks_count: 5,
          open_issues_count: 2,
          language: "JavaScript",
          license: { name: "MIT" },
        });
      }
      if (url.startsWith("https://api.github.com/repos/facebook/react/git/trees/HEAD")) {
        return jsonResponse({
          tree: [
            { path: "src", type: "tree" },
            { path: "README.md", type: "blob" },
          ],
        });
      }
      if (url === "https://api.github.com/repos/facebook/react/readme") {
        return jsonResponse({
          content: Buffer.from("# Hello").toString("base64"),
          encoding: "base64",
        });
      }
      return undefined;
    });
    const result = await handleGitHub("https://github.com/facebook/react", ctx);
    expect(result?.method).toBe("github-repo");
    expect(result?.content).toContain("# facebook/react");
    expect(result?.content).toContain("## Files");
    expect(result?.content).toContain("## README");
  });

  it("fetches a blob through raw.githubusercontent.com", async () => {
    const ctx = fixtureContext((url) =>
      url.startsWith("https://raw.githubusercontent.com/") ? textResponse("file body") : undefined,
    );
    const result = await handleGitHub("https://github.com/o/r/blob/main/file.txt", ctx);
    expect(result?.method).toBe("github-raw");
    expect(result?.content).toBe("file body");
  });

  it("renders an issue", async () => {
    const ctx = fixtureContext((url) => {
      if (url === "https://api.github.com/repos/o/r/issues/1") {
        return jsonResponse({
          title: "Bug report",
          number: 1,
          state: "open",
          user: { login: "alice" },
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
          body: "It broke",
          labels: [{ name: "bug" }],
          comments: 0,
        });
      }
      return undefined;
    });
    const result = await handleGitHub("https://github.com/o/r/issues/1", ctx);
    expect(result?.method).toBe("github-issue");
    expect(result?.content).toContain("Bug report");
    expect(result?.content).toContain("It broke");
  });
});
