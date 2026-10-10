import { describe, expect, it } from "vitest";
import { fixtureContext, jsonResponse, textResponse } from "../__fixtures__/context";
import { handleGitLab, parseGitLabUrl } from "./gitlab";

describe("parseGitLabUrl", () => {
  it("classifies repo, blob, tree, issue, and MR URLs", () => {
    expect(parseGitLabUrl("https://gitlab.com/ns/proj")).toEqual({
      namespace: "ns",
      project: "proj",
      type: "repo",
    });
    expect(parseGitLabUrl("https://gitlab.com/ns/proj/-/blob/main/src/a.ts")).toEqual({
      namespace: "ns",
      project: "proj",
      type: "blob",
      ref: "main",
      path: "src/a.ts",
    });
    expect(parseGitLabUrl("https://gitlab.com/ns/proj/-/issues/7")).toEqual({
      namespace: "ns",
      project: "proj",
      type: "issue",
      id: 7,
    });
    expect(parseGitLabUrl("https://gitlab.com/ns/proj/-/merge_requests/9")).toEqual({
      namespace: "ns",
      project: "proj",
      type: "merge_request",
      id: 9,
    });
    expect(parseGitLabUrl("https://github.com/ns/proj")).toBeNull();
  });
});

describe("handleGitLab", () => {
  it("returns null for non-GitLab URLs", async () => {
    const ctx = fixtureContext(() => undefined);
    expect(await handleGitLab("https://example.com", ctx)).toBeNull();
  });

  it("renders a repository with its README", async () => {
    const ctx = fixtureContext((url) => {
      if (url === "https://gitlab.com/api/v4/projects/ns%2Fproj") {
        return jsonResponse({
          name: "proj",
          description: "A project",
          star_count: 3,
          forks_count: 1,
          open_issues_count: 0,
          default_branch: "main",
          visibility: "public",
          created_at: "2024-01-01T00:00:00Z",
          last_activity_at: "2024-02-01T00:00:00Z",
          readme_url: "https://gitlab.com/ns/proj/-/raw/main/README.md",
        });
      }
      if (url === "https://gitlab.com/ns/proj/-/raw/main/README.md")
        return textResponse("# Readme");
      return undefined;
    });
    const result = await handleGitLab("https://gitlab.com/ns/proj", ctx);
    expect(result?.method).toBe("gitlab-repo");
    expect(result?.content).toContain("## README");
    expect(result?.content).toContain("# Readme");
  });

  it("fetches a raw file", async () => {
    const ctx = fixtureContext((url) => {
      if (url === "https://gitlab.com/api/v4/projects/ns%2Fproj") return jsonResponse({ id: 1 });
      if (url === "https://gitlab.com/api/v4/projects/1/repository/files/src%2Fa.ts/raw?ref=main") {
        return textResponse("export const a = 1;");
      }
      return undefined;
    });
    const result = await handleGitLab("https://gitlab.com/ns/proj/-/blob/main/src/a.ts", ctx);
    expect(result?.method).toBe("gitlab-raw");
    expect(result?.content).toBe("export const a = 1;");
  });

  it("omits the issue count when the API does not provide it and reads the raw README", async () => {
    const ctx = fixtureContext((url) => {
      if (url === "https://gitlab.com/api/v4/projects/ns%2Fproj") {
        return jsonResponse({
          name: "proj",
          star_count: 3,
          forks_count: 1,
          default_branch: "main",
          visibility: "public",
          created_at: "2024-01-01T00:00:00Z",
          last_activity_at: "2024-02-01T00:00:00Z",
          readme_url: "https://gitlab.com/ns/proj/-/blob/main/README.md",
        });
      }
      if (url === "https://gitlab.com/ns/proj/-/raw/main/README.md")
        return textResponse("# Readme");
      return undefined;
    });
    const result = await handleGitLab("https://gitlab.com/ns/proj", ctx);
    expect(result?.content).not.toContain("NaN");
    expect(result?.content).toContain("# Readme");
  });

  it("preserves Markdown in issue descriptions", async () => {
    const ctx = fixtureContext((url) => {
      if (url === "https://gitlab.com/api/v4/projects/ns%2Fproj") return jsonResponse({ id: 7 });
      if (url === "https://gitlab.com/api/v4/projects/7/issues/7") {
        return jsonResponse({
          title: "Issue",
          state: "opened",
          author: { name: "Ada", username: "ada" },
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
          labels: [],
          upvotes: 0,
          downvotes: 0,
          user_notes_count: 0,
          description: "Use `code` here.\n\n```ts\nconst x = 1;\n```",
        });
      }
      return undefined;
    });
    const result = await handleGitLab("https://gitlab.com/ns/proj/-/issues/7", ctx);
    expect(result?.content).toContain("Use `code` here.");
    expect(result?.content).toContain("```ts");
    expect(result?.content).not.toContain("\\`");
  });
});
