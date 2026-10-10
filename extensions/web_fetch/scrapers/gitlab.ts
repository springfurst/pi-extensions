// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { formatNumber } from "../../../lib/format";
import type { FetchContext, RenderResult, SpecialHandler } from "./types";
import { buildResult, formatIsoDate, parseJson } from "./types";

interface GitLabUrl {
  namespace: string;
  project: string;
  type: "repo" | "blob" | "tree" | "issue" | "merge_request";
  ref?: string;
  path?: string;
  id?: number;
}

/** Parse a GitLab.com URL into its components. Exported for tests. */
export function parseGitLabUrl(url: string): GitLabUrl | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "gitlab.com") return null;

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const [namespace, project, ...rest] = segments as [string, string, ...string[]];
    if (rest.length === 0) return { namespace, project, type: "repo" };
    if (rest[0] !== "-") return null;

    const [, type, ...remaining] = rest as [string, string, ...string[]];
    if (type === "blob" && remaining.length >= 2) {
      const [ref, ...pathParts] = remaining;
      return { namespace, project, type: "blob", ref, path: pathParts.join("/") };
    }
    if (type === "tree" && remaining.length >= 1) {
      const [ref, ...pathParts] = remaining;
      return {
        namespace,
        project,
        type: "tree",
        ref,
        path: pathParts.length > 0 ? pathParts.join("/") : undefined,
      };
    }
    if (type === "issues" && remaining.length === 1) {
      const id = parseInt(remaining[0]!, 10);
      return Number.isNaN(id) ? null : { namespace, project, type: "issue", id };
    }
    if (type === "merge_requests" && remaining.length === 1) {
      const id = parseInt(remaining[0]!, 10);
      return Number.isNaN(id) ? null : { namespace, project, type: "merge_request", id };
    }
    return null;
  } catch {
    return null;
  }
}

function projectApiUrl(gl: GitLabUrl): string {
  return `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${gl.namespace}/${gl.project}`)}`;
}

function projectByIdUrl(projectId: number): string {
  return `https://gitlab.com/api/v4/projects/${projectId}`;
}

async function getProjectId(gl: GitLabUrl, ctx: FetchContext): Promise<number | null> {
  const result = await ctx.loadPage(projectApiUrl(gl), { signal: ctx.signal });
  if (!result.ok) return null;
  const data = parseJson<{ id: number }>(result.content);
  return data?.id ?? null;
}

async function renderGitLabRepo(
  gl: GitLabUrl,
  ctx: FetchContext,
): Promise<{ content: string; ok: boolean }> {
  const result = await ctx.loadPage(projectApiUrl(gl), { signal: ctx.signal });
  if (!result.ok) return { content: "", ok: false };

  const repo = parseJson<{
    name: string;
    description?: string;
    star_count: number;
    forks_count: number;
    open_issues_count?: number;
    default_branch: string;
    visibility: string;
    created_at: string;
    last_activity_at: string;
    topics?: string[];
    readme_url?: string;
  }>(result.content);
  if (!repo) return { content: "", ok: false };

  let md = `# ${repo.name}\n\n`;
  if (repo.description) md += `${repo.description}\n\n`;
  let stats = `**Stars:** ${formatNumber(repo.star_count)} · **Forks:** ${formatNumber(repo.forks_count)}`;
  if (typeof repo.open_issues_count === "number")
    stats += ` · **Issues:** ${formatNumber(repo.open_issues_count)}`;
  md += `${stats}\n`;
  md += `**Visibility:** ${repo.visibility} · **Default Branch:** ${repo.default_branch}\n`;
  if (repo.topics && repo.topics.length > 0) md += `**Topics:** ${repo.topics.join(", ")}\n`;
  md += `**Created:** ${formatIsoDate(repo.created_at)} · **Last Activity:** ${formatIsoDate(repo.last_activity_at)}\n\n`;

  if (repo.readme_url) {
    const rawUrl = repo.readme_url.replace("/-/blob/", "/-/raw/");
    const readme = await ctx.loadPage(rawUrl, { signal: ctx.signal });
    if (readme.ok && readme.content.trim().length > 0)
      md += `---\n\n## README\n\n${readme.content}\n`;
  }
  return { content: md, ok: true };
}

async function renderGitLabFile(
  gl: GitLabUrl,
  projectId: number,
  ctx: FetchContext,
): Promise<{ content: string; ok: boolean }> {
  const apiUrl = `${projectByIdUrl(projectId)}/repository/files/${encodeURIComponent(gl.path!)}/raw?ref=${gl.ref}`;
  const result = await ctx.loadPage(apiUrl, { signal: ctx.signal });
  return result.ok ? { content: result.content, ok: true } : { content: "", ok: false };
}

async function renderGitLabTree(
  gl: GitLabUrl,
  projectId: number,
  ctx: FetchContext,
): Promise<{ content: string; ok: boolean }> {
  const apiUrl = `${projectByIdUrl(projectId)}/repository/tree?ref=${gl.ref}&path=${gl.path || ""}&per_page=100`;
  const result = await ctx.loadPage(apiUrl, { signal: ctx.signal });
  if (!result.ok) return { content: "", ok: false };

  const tree = parseJson<Array<{ name: string; type: "tree" | "blob" }>>(result.content);
  if (!tree) return { content: "", ok: false };

  const dirs = tree.filter((item) => item.type === "tree");
  const files = tree.filter((item) => item.type === "blob");
  let md = `# Directory: ${gl.path || "/"}\n\n**Ref:** ${gl.ref}\n\n`;
  if (dirs.length > 0) {
    md += `## Directories (${dirs.length})\n\n`;
    for (const dir of dirs) md += `- ${dir.name}/\n`;
    md += "\n";
  }
  if (files.length > 0) {
    md += `## Files (${files.length})\n\n`;
    for (const file of files) md += `- ${file.name}\n`;
  }
  return { content: md, ok: true };
}

async function renderGitLabIssue(
  gl: GitLabUrl,
  projectId: number,
  ctx: FetchContext,
): Promise<{ content: string; ok: boolean }> {
  const result = await ctx.loadPage(`${projectByIdUrl(projectId)}/issues/${gl.id}`, {
    signal: ctx.signal,
  });
  if (!result.ok) return { content: "", ok: false };

  const issue = parseJson<{
    title: string;
    description?: string;
    state: string;
    author: { name: string; username: string };
    created_at: string;
    updated_at: string;
    labels: string[];
    upvotes: number;
    downvotes: number;
    user_notes_count: number;
    assignees?: Array<{ name: string }>;
  }>(result.content);
  if (!issue) return { content: "", ok: false };

  let md = `# Issue #${gl.id}: ${issue.title}\n\n`;
  md += `**State:** ${issue.state.toUpperCase()} · **Author:** ${issue.author.name} (@${issue.author.username})\n`;
  md += `**Created:** ${formatIsoDate(issue.created_at)} · **Updated:** ${formatIsoDate(issue.updated_at)}\n`;
  md += `**Upvotes:** ${issue.upvotes} · **Downvotes:** ${issue.downvotes} · **Comments:** ${issue.user_notes_count}\n`;
  if (issue.labels.length > 0) md += `**Labels:** ${issue.labels.join(", ")}\n`;
  if (issue.assignees && issue.assignees.length > 0)
    md += `**Assignees:** ${issue.assignees.map((a) => a.name).join(", ")}\n`;
  md += `\n---\n\n## Description\n\n`;
  md += issue.description ? issue.description : "*No description*";
  return { content: md, ok: true };
}

async function renderGitLabMr(
  gl: GitLabUrl,
  projectId: number,
  ctx: FetchContext,
): Promise<{ content: string; ok: boolean }> {
  const result = await ctx.loadPage(`${projectByIdUrl(projectId)}/merge_requests/${gl.id}`, {
    signal: ctx.signal,
  });
  if (!result.ok) return { content: "", ok: false };

  const mr = parseJson<{
    title: string;
    description?: string;
    state: string;
    author: { name: string; username: string };
    created_at: string;
    updated_at: string;
    source_branch: string;
    target_branch: string;
    labels: string[];
    upvotes: number;
    downvotes: number;
    user_notes_count: number;
    assignees?: Array<{ name: string }>;
    draft: boolean;
    merge_status: string;
  }>(result.content);
  if (!mr) return { content: "", ok: false };

  let md = `# MR !${gl.id}: ${mr.title}\n\n`;
  if (mr.draft) md += `**[DRAFT]** `;
  md += `**State:** ${mr.state.toUpperCase()} · **Author:** ${mr.author.name} (@${mr.author.username})\n`;
  md += `**Branch:** ${mr.source_branch} → ${mr.target_branch}\n`;
  md += `**Created:** ${formatIsoDate(mr.created_at)} · **Updated:** ${formatIsoDate(mr.updated_at)}\n`;
  md += `**Merge Status:** ${mr.merge_status} · **Upvotes:** ${mr.upvotes} · **Downvotes:** ${mr.downvotes} · **Comments:** ${mr.user_notes_count}\n`;
  if (mr.labels.length > 0) md += `**Labels:** ${mr.labels.join(", ")}\n`;
  if (mr.assignees && mr.assignees.length > 0)
    md += `**Assignees:** ${mr.assignees.map((a) => a.name).join(", ")}\n`;
  md += `\n---\n\n## Description\n\n`;
  md += mr.description ? mr.description : "*No description*";
  return { content: md, ok: true };
}

/** Handle GitLab URLs specially. */
export const handleGitLab: SpecialHandler = async (url, ctx): Promise<RenderResult | null> => {
  const gl = parseGitLabUrl(url);
  if (!gl) return null;

  const fetchedAt = new Date().toISOString();
  const notes = ["Fetched via GitLab API"];

  switch (gl.type) {
    case "blob": {
      const projectId = await getProjectId(gl, ctx);
      if (!projectId) break;
      const result = await renderGitLabFile(gl, projectId, ctx);
      if (result.ok) {
        return buildResult(result.content, {
          url,
          method: "gitlab-raw",
          fetchedAt,
          notes,
          contentType: "text/plain",
        });
      }
      break;
    }
    case "tree": {
      const projectId = await getProjectId(gl, ctx);
      if (!projectId) break;
      const result = await renderGitLabTree(gl, projectId, ctx);
      if (result.ok)
        return buildResult(result.content, { url, method: "gitlab-tree", fetchedAt, notes });
      break;
    }
    case "issue": {
      const projectId = await getProjectId(gl, ctx);
      if (!projectId) break;
      const result = await renderGitLabIssue(gl, projectId, ctx);
      if (result.ok)
        return buildResult(result.content, { url, method: "gitlab-issue", fetchedAt, notes });
      break;
    }
    case "merge_request": {
      const projectId = await getProjectId(gl, ctx);
      if (!projectId) break;
      const result = await renderGitLabMr(gl, projectId, ctx);
      if (result.ok)
        return buildResult(result.content, { url, method: "gitlab-mr", fetchedAt, notes });
      break;
    }
    case "repo": {
      const result = await renderGitLabRepo(gl, ctx);
      if (result.ok)
        return buildResult(result.content, { url, method: "gitlab-repo", fetchedAt, notes });
      break;
    }
  }

  return null;
};
