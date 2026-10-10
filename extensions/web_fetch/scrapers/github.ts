// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

import { formatNumber } from "../../../lib/format";
import type { FetchContext, RenderResult, SpecialHandler } from "./types";
import { buildResult, parseJson } from "./types";

interface GitHubUrl {
  type:
    | "blob"
    | "tree"
    | "repo"
    | "commit"
    | "issue"
    | "issues"
    | "pull"
    | "pulls"
    | "discussion"
    | "discussions"
    | "actions-run"
    | "actions-job"
    | "other";
  owner: string;
  repo: string;
  ref?: string;
  path?: string;
  number?: number;
  runId?: number;
  jobId?: number;
}

interface GitHubIssueComment {
  user: { login: string } | null;
  created_at: string;
  body: string;
}

/** Parse a GitHub URL into its components. Exported for tests. */
export function parseGitHubUrl(url: string): GitHubUrl | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;

    const [owner, repo, ...rest] = parts as [string, string, ...string[]];

    if (rest.length === 0) return { type: "repo", owner, repo };

    const [section, ...subParts] = rest as [string, ...string[]];

    switch (section) {
      case "blob":
      case "tree": {
        const [ref, ...pathParts] = subParts;
        return { type: section, owner, repo, ref, path: pathParts.join("/") };
      }
      case "commit":
        if (subParts.length > 0 && subParts[0])
          return { type: "commit", owner, repo, ref: subParts[0] };
        return { type: "other", owner, repo };
      case "issues":
        if (subParts.length > 0 && /^\d+$/.test(subParts[0]!)) {
          return { type: "issue", owner, repo, number: parseInt(subParts[0]!, 10) };
        }
        return { type: "issues", owner, repo };
      case "pull":
        if (subParts.length > 0 && /^\d+$/.test(subParts[0]!)) {
          return { type: "pull", owner, repo, number: parseInt(subParts[0]!, 10) };
        }
        return { type: "pulls", owner, repo };
      case "pulls":
        return { type: "pulls", owner, repo };
      case "actions": {
        if (subParts[0] === "runs" && /^\d+$/.test(subParts[1] ?? "")) {
          const runId = parseInt(subParts[1]!, 10);
          const segment = subParts[2];
          if ((segment === "job" || segment === "jobs") && /^\d+$/.test(subParts[3] ?? "")) {
            return { type: "actions-job", owner, repo, runId, jobId: parseInt(subParts[3]!, 10) };
          }
          return { type: "actions-run", owner, repo, runId };
        }
        return { type: "other", owner, repo };
      }
      case "discussions":
        if (subParts.length > 0 && /^\d+$/.test(subParts[0]!)) {
          return { type: "discussion", owner, repo, number: parseInt(subParts[0]!, 10) };
        }
        return { type: "discussions", owner, repo };
      default:
        return { type: "other", owner, repo };
    }
  } catch {
    return null;
  }
}

function toRawGitHubUrl(gh: GitHubUrl): string {
  return `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.ref}/${gh.path}`;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Fetch a GitHub API endpoint and parse JSON. */
export async function fetchGitHubApi(
  endpoint: string,
  ctx: FetchContext,
): Promise<{ data: unknown; ok: boolean }> {
  const result = await ctx.loadPage(`https://api.github.com${endpoint}`, {
    signal: ctx.signal,
    headers: githubHeaders(),
  });
  if (!result.ok) return { data: null, ok: false };
  return { data: parseJson(result.content), ok: true };
}

async function fetchGitHubIssueComments(
  owner: string,
  repo: string,
  issueNumber: number,
  expectedCount: number,
  ctx: FetchContext,
): Promise<GitHubIssueComment[]> {
  const perPage = 100;
  const comments: GitHubIssueComment[] = [];

  for (let page = 1; comments.length < expectedCount; page++) {
    const result = await fetchGitHubApi(
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`,
      ctx,
    );
    if (!result.ok || !Array.isArray(result.data)) break;
    const pageComments = result.data as GitHubIssueComment[];
    if (pageComments.length === 0) break;
    comments.push(...pageComments);
    if (pageComments.length < perPage) break;
  }
  return comments;
}

async function renderGitHubIssue(
  gh: GitHubUrl,
  ctx: FetchContext,
): Promise<{ content: string; ok: boolean }> {
  const endpoint =
    gh.type === "pull"
      ? `/repos/${gh.owner}/${gh.repo}/pulls/${gh.number}`
      : `/repos/${gh.owner}/${gh.repo}/issues/${gh.number}`;

  const result = await fetchGitHubApi(endpoint, ctx);
  if (!result.ok || !result.data) return { content: "", ok: false };

  const issue = result.data as {
    title: string;
    number: number;
    state: string;
    user: { login: string } | null;
    created_at: string;
    updated_at: string;
    body: string | null;
    labels: Array<{ name: string }>;
    comments: number;
  };

  let md = `# ${issue.title}\n\n`;
  md += `**#${issue.number}** · ${issue.state} · opened by @${issue.user?.login ?? "ghost"}\n`;
  md += `Created: ${issue.created_at} · Updated: ${issue.updated_at}\n`;
  if (issue.labels.length > 0)
    md += `Labels: ${issue.labels.map((label) => label.name).join(", ")}\n`;
  md += `\n---\n\n`;
  md += issue.body || "*No description provided.*";
  md += `\n\n---\n\n`;

  if (issue.comments > 0) {
    const comments = await fetchGitHubIssueComments(
      gh.owner,
      gh.repo,
      issue.number,
      issue.comments,
      ctx,
    );
    if (comments.length > 0) {
      const commentCount =
        issue.comments > comments.length
          ? `${comments.length} of ${issue.comments}`
          : `${comments.length}`;
      md += `## Comments (${commentCount})\n\n`;
      for (const comment of comments) {
        md += `### @${comment.user?.login ?? "ghost"} · ${comment.created_at}\n\n`;
        md += `${comment.body}\n\n---\n\n`;
      }
    }
  }

  return { content: md, ok: true };
}

interface GitHubCommitFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

async function renderGitHubCommit(
  gh: GitHubUrl,
  ctx: FetchContext,
): Promise<{ content: string; ok: boolean }> {
  const result = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/commits/${gh.ref}`, ctx);
  if (!result.ok || !result.data) return { content: "", ok: false };

  const commit = result.data as {
    sha: string;
    commit: {
      author?: { name?: string; date?: string } | null;
      message: string;
    };
    author?: { login: string } | null;
    parents?: Array<{ sha: string }>;
    stats?: { additions?: number; deletions?: number };
    files?: GitHubCommitFile[];
  };

  const message = commit.commit.message ?? "";
  const [subject, ...bodyLines] = message.split("\n");
  const authorName = commit.author?.login
    ? `@${commit.author.login}`
    : (commit.commit.author?.name ?? "unknown");
  const authoredAt = commit.commit.author?.date ?? "";

  let md = `# ${subject || commit.sha.slice(0, 7)}\n\n`;
  md += `**${commit.sha.slice(0, 12)}** · authored by ${authorName}`;
  if (authoredAt) md += ` · ${authoredAt}`;
  md += `\n`;
  if (commit.stats) {
    const { additions = 0, deletions = 0 } = commit.stats;
    const fileCount = commit.files?.length ?? 0;
    md += `${fileCount} file${fileCount === 1 ? "" : "s"} changed · +${additions} −${deletions}\n`;
  }
  if (commit.parents && commit.parents.length > 0) {
    md += `Parents: ${commit.parents.map((parent) => parent.sha.slice(0, 12)).join(", ")}\n`;
  }

  const body = bodyLines.join("\n").trim();
  if (body) md += `\n${body}\n`;

  const files = commit.files ?? [];
  if (files.length > 0) {
    md += `\n---\n\n## Files (${files.length})\n\n`;
    for (const file of files) {
      const name = file.previous_filename
        ? `${file.previous_filename} → ${file.filename}`
        : file.filename;
      md += `### ${name}\n\n${file.status} · +${file.additions} −${file.deletions}\n\n`;
      md += file.patch
        ? `\`\`\`diff\n${file.patch}\n\`\`\`\n\n`
        : `*No textual diff (binary or too large).*\n\n`;
    }
  }

  return { content: md, ok: true };
}

async function renderGitHubIssuesList(
  gh: GitHubUrl,
  ctx: FetchContext,
): Promise<{ content: string; ok: boolean }> {
  const result = await fetchGitHubApi(
    `/repos/${gh.owner}/${gh.repo}/issues?state=open&per_page=30`,
    ctx,
  );
  if (!result.ok || !Array.isArray(result.data)) return { content: "", ok: false };

  const issues = result.data as Array<{
    number: number;
    title: string;
    user: { login: string } | null;
    created_at: string;
    comments: number;
    labels: Array<{ name: string }>;
    pull_request?: unknown;
  }>;

  let md = `# ${gh.owner}/${gh.repo} - Open Issues\n\n`;
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const labels =
      issue.labels.length > 0 ? ` [${issue.labels.map((label) => label.name).join(", ")}]` : "";
    md += `- **#${issue.number}** ${issue.title}${labels}\n`;
    md += `  by @${issue.user?.login ?? "ghost"} · ${issue.comments} comments · ${issue.created_at}\n\n`;
  }
  return { content: md, ok: true };
}

async function renderGitHubTree(
  gh: GitHubUrl,
  ctx: FetchContext,
): Promise<{ content: string; ok: boolean }> {
  const repoResult = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}`, ctx);
  if (!repoResult.ok || !repoResult.data) return { content: "", ok: false };
  const repo = repoResult.data as { full_name: string; default_branch: string };

  const ref = gh.ref || repo.default_branch;
  const dirPath = gh.path || "";

  let md = `# ${repo.full_name}/${dirPath || "(root)"}\n\n**Branch:** ${ref}\n\n`;

  const contentsResult = await fetchGitHubApi(
    `/repos/${gh.owner}/${gh.repo}/contents/${dirPath}?ref=${ref}`,
    ctx,
  );
  if (contentsResult.ok && Array.isArray(contentsResult.data)) {
    const items = contentsResult.data as Array<{
      name: string;
      type: "file" | "dir" | "symlink" | "submodule";
      size?: number;
    }>;
    items.sort((a, b) => {
      if (a.type === "dir" && b.type !== "dir") return -1;
      if (a.type !== "dir" && b.type === "dir") return 1;
      return a.name.localeCompare(b.name);
    });

    md += `## Contents\n\n\`\`\`\n`;
    for (const item of items) {
      const prefix = item.type === "dir" ? "[dir] " : "      ";
      const size = item.size ? ` (${item.size} bytes)` : "";
      md += `${prefix}${item.name}${item.type === "file" ? size : ""}\n`;
    }
    md += "```\n\n";

    const readmeFile = items.find(
      (item) => item.type === "file" && /^readme\.md$/i.test(item.name),
    );
    if (readmeFile) {
      const readmePath = dirPath ? `${dirPath}/${readmeFile.name}` : readmeFile.name;
      const rawUrl = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${ref}/${readmePath}`;
      const readmeResult = await ctx.loadPage(rawUrl, { signal: ctx.signal });
      if (readmeResult.ok) md += `---\n\n## README\n\n${readmeResult.content}`;
    }
  }

  return { content: md, ok: true };
}

async function renderGitHubRepo(
  gh: GitHubUrl,
  ctx: FetchContext,
): Promise<{ content: string; ok: boolean }> {
  const [repoResult, treeResult, readmeResult] = await Promise.all([
    fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}`, ctx),
    fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/git/trees/HEAD?recursive=1`, ctx),
    fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/readme`, ctx),
  ]);
  if (!repoResult.ok || !repoResult.data) return { content: "", ok: false };

  const repo = repoResult.data as {
    full_name: string;
    description: string | null;
    stargazers_count: number;
    forks_count: number;
    open_issues_count: number;
    language: string | null;
    license: { name: string } | null;
  };

  let md = `# ${repo.full_name}\n\n`;
  if (repo.description) md += `${repo.description}\n\n`;
  md += `Stars: ${formatNumber(repo.stargazers_count)} · Forks: ${formatNumber(repo.forks_count)} · Issues: ${formatNumber(repo.open_issues_count)}\n`;
  if (repo.language) md += `Language: ${repo.language}\n`;
  if (repo.license) md += `License: ${repo.license.name}\n`;
  md += `\n---\n\n`;

  if (treeResult.ok && treeResult.data) {
    const tree = (treeResult.data as { tree: Array<{ path: string; type: string }> }).tree;
    md += `## Files\n\n\`\`\`\n`;
    for (const item of tree.slice(0, 100)) {
      md += `${item.type === "tree" ? "[dir] " : "      "}${item.path}\n`;
    }
    if (tree.length > 100) md += `[…${tree.length - 100} files elided…]\n`;
    md += "```\n\n";
  }

  if (readmeResult.ok && readmeResult.data) {
    const readme = readmeResult.data as { content: string; encoding: string };
    if (readme.encoding === "base64") {
      md += `## README\n\n${Buffer.from(readme.content, "base64").toString("utf-8")}`;
    }
  }

  return { content: md, ok: true };
}

interface GitHubActionsStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  started_at: string | null;
  completed_at: string | null;
}

interface GitHubActionsJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  steps?: GitHubActionsStep[];
  runner_name?: string | null;
  workflow_name?: string | null;
  head_branch?: string | null;
}

interface GitHubActionsRun {
  name?: string | null;
  display_title?: string;
  run_number: number;
  run_attempt?: number;
  event: string;
  status: string;
  conclusion: string | null;
  head_branch?: string | null;
  head_sha?: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  actor?: { login: string };
  triggering_actor?: { login: string };
}

function statusLabel(status: string, conclusion: string | null | undefined): string {
  return conclusion ? `${status} (${conclusion})` : status;
}

function actionDuration(start?: string | null, end?: string | null): string {
  if (!start || !end) return "";
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/** Strip the per-line ISO timestamp prefix GitHub prepends to job log lines, plus a leading BOM. */
export function stripActionsLogTimestamps(logs: string): string {
  return logs.replace(/^\uFEFF/, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm, "");
}

function renderActionsSteps(steps?: GitHubActionsStep[]): string {
  if (!steps || steps.length === 0) return "";
  let md = "| # | Step | Status | Conclusion | Duration |\n";
  md += "|---|------|--------|------------|----------|\n";
  for (const step of steps) {
    const duration = actionDuration(step.started_at, step.completed_at) || "-";
    md += `| ${step.number} | ${escapeCell(step.name)} | ${step.status} | ${step.conclusion ?? "-"} | ${duration} |\n`;
  }
  return `${md}\n`;
}

function renderActionsRunMeta(run: GitHubActionsRun): string {
  let md = `**Workflow:** ${run.name ?? "(unknown)"}\n`;
  md += `**Run:** #${run.run_number}`;
  if (run.run_attempt && run.run_attempt > 1) md += ` (attempt ${run.run_attempt})`;
  md += ` · ${statusLabel(run.status, run.conclusion)}\n`;
  if (run.head_branch)
    md += `**Branch:** ${run.head_branch}${run.head_sha ? ` @ ${run.head_sha.slice(0, 7)}` : ""}\n`;
  const actor = run.triggering_actor?.login ?? run.actor?.login;
  md += `**Event:** ${run.event}${actor ? ` · by @${actor}` : ""}\n`;
  const started = run.run_started_at ?? run.created_at;
  const duration = actionDuration(started, run.updated_at);
  md += `Started: ${started}${duration ? ` · Duration: ${duration}` : ""}\n`;
  md += `URL: ${run.html_url}\n`;
  return md;
}

async function fetchGitHubJobLogs(
  owner: string,
  repo: string,
  jobId: number,
  ctx: FetchContext,
): Promise<string | null> {
  const result = await ctx.loadPage(
    `https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
    {
      signal: ctx.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...githubHeaders(),
      },
    },
  );
  return result.ok && result.content ? result.content : null;
}

async function renderGitHubActionsRun(
  gh: GitHubUrl,
  ctx: FetchContext,
): Promise<{ content: string; ok: boolean }> {
  const [runResult, jobsResult] = await Promise.all([
    fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/actions/runs/${gh.runId}`, ctx),
    fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/actions/runs/${gh.runId}/jobs?per_page=100`, ctx),
  ]);
  if (!runResult.ok || !runResult.data) return { content: "", ok: false };

  const run = runResult.data as GitHubActionsRun;
  let md = `# ${run.display_title || run.name || `Run #${run.run_number}`}\n\n`;
  md += renderActionsRunMeta(run);
  md += `\n---\n\n`;

  if (jobsResult.ok && jobsResult.data) {
    const jobs = (jobsResult.data as { jobs?: GitHubActionsJob[] }).jobs ?? [];
    md += `## Jobs (${jobs.length})\n\n`;
    for (const job of jobs) {
      const duration = actionDuration(job.started_at, job.completed_at);
      md += `### ${escapeCell(job.name)} — ${statusLabel(job.status, job.conclusion)}${duration ? ` (${duration})` : ""}\n\n`;
      if (job.conclusion !== "success") md += renderActionsSteps(job.steps);
    }
  }

  return { content: md, ok: true };
}

async function renderGitHubActionsJob(
  gh: GitHubUrl,
  ctx: FetchContext,
): Promise<{ content: string; ok: boolean }> {
  const runEndpoint = (runId: number | undefined) =>
    `/repos/${gh.owner}/${gh.repo}/actions/runs/${runId}`;
  const [jobResult, urlRunResult] = await Promise.all([
    fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/actions/jobs/${gh.jobId}`, ctx),
    fetchGitHubApi(runEndpoint(gh.runId), ctx),
  ]);
  if (!jobResult.ok || !jobResult.data) return { content: "", ok: false };

  const job = jobResult.data as GitHubActionsJob;
  const runResult =
    job.run_id === gh.runId ? urlRunResult : await fetchGitHubApi(runEndpoint(job.run_id), ctx);
  const run = runResult.ok && runResult.data ? (runResult.data as GitHubActionsRun) : null;

  let md = `# ${escapeCell(job.name)}\n\n`;
  if (run) md += renderActionsRunMeta(run);
  else if (job.workflow_name) {
    md += `**Workflow:** ${job.workflow_name}\n`;
    if (job.head_branch) md += `**Branch:** ${job.head_branch}\n`;
  }
  const duration = actionDuration(job.started_at, job.completed_at);
  md += `**Job:** ${escapeCell(job.name)} · ${statusLabel(job.status, job.conclusion)}${duration ? ` · ${duration}` : ""}\n`;
  if (job.runner_name) md += `**Runner:** ${job.runner_name}\n`;
  if (job.html_url) md += `URL: ${job.html_url}\n`;
  md += `\n---\n\n`;

  const steps = renderActionsSteps(job.steps);
  if (steps) md += `## Steps\n\n${steps}`;

  const logs = await fetchGitHubJobLogs(gh.owner, gh.repo, job.id, ctx);
  md += `## Logs\n\n`;
  md += logs
    ? stripActionsLogTimestamps(logs)
    : "*Logs unavailable — requires a GITHUB_TOKEN/GH_TOKEN with read access, or the run's logs have expired.*\n";

  return { content: md, ok: true };
}

/** Handle GitHub URLs specially. */
export const handleGitHub: SpecialHandler = async (url, ctx): Promise<RenderResult | null> => {
  const gh = parseGitHubUrl(url);
  if (!gh) return null;

  const fetchedAt = new Date().toISOString();
  const notes = ["Fetched via GitHub API"];

  switch (gh.type) {
    case "blob": {
      const rawUrl = toRawGitHubUrl(gh);
      const result = await ctx.loadPage(rawUrl, { signal: ctx.signal });
      if (result.ok) {
        return buildResult(result.content, {
          url,
          finalUrl: rawUrl,
          method: "github-raw",
          fetchedAt,
          notes: [`Fetched raw: ${rawUrl}`],
          contentType: "text/plain",
        });
      }
      break;
    }
    case "tree": {
      const result = await renderGitHubTree(gh, ctx);
      if (result.ok)
        return buildResult(result.content, { url, method: "github-tree", fetchedAt, notes });
      break;
    }
    case "commit": {
      const result = await renderGitHubCommit(gh, ctx);
      if (result.ok)
        return buildResult(result.content, { url, method: "github-commit", fetchedAt, notes });
      break;
    }
    case "issue":
    case "pull": {
      const result = await renderGitHubIssue(gh, ctx);
      if (result.ok) {
        return buildResult(result.content, {
          url,
          method: gh.type === "pull" ? "github-pr" : "github-issue",
          fetchedAt,
          notes,
        });
      }
      break;
    }
    case "issues": {
      const result = await renderGitHubIssuesList(gh, ctx);
      if (result.ok)
        return buildResult(result.content, { url, method: "github-issues", fetchedAt, notes });
      break;
    }
    case "repo": {
      const result = await renderGitHubRepo(gh, ctx);
      if (result.ok)
        return buildResult(result.content, { url, method: "github-repo", fetchedAt, notes });
      break;
    }
    case "actions-run": {
      const result = await renderGitHubActionsRun(gh, ctx);
      if (result.ok)
        return buildResult(result.content, { url, method: "github-actions-run", fetchedAt, notes });
      break;
    }
    case "actions-job": {
      const result = await renderGitHubActionsJob(gh, ctx);
      if (result.ok)
        return buildResult(result.content, { url, method: "github-actions-job", fetchedAt, notes });
      break;
    }
  }

  return null;
};
