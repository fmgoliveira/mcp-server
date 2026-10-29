import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import { account, accountOrAll, fanOut, tool } from "./common.js";

const GH = "https://api.github.com";
const gh = (label: string, path: string, opts: Parameters<typeof api>[3] = {}) =>
  api(label, "github", path.startsWith("http") ? path : GH + path, opts);

const repoShape = {
  owner: z.string().describe("Repository owner (user or org)"),
  repo: z.string().describe("Repository name"),
};
const rp = (a: { owner: string; repo: string }) => `/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}`;
const num = z.number().int().describe("Issue or pull request number");
const perPage = z.number().int().min(1).max(100).default(30);

const slimIssue = (i: any) => ({
  number: i.number, title: i.title, state: i.state, draft: i.draft, author: i.user?.login,
  repo: i.repository_url?.replace(`${GH}/repos/`, "") ?? i.repository?.full_name,
  labels: i.labels?.map((l: any) => l.name ?? l), assignees: i.assignees?.map((a: any) => a.login),
  comments: i.comments, created: i.created_at, updated: i.updated_at, url: i.html_url, is_pr: !!i.pull_request,
});

const slimRepo = (r: any) => ({
  full_name: r.full_name, private: r.private, fork: r.fork, archived: r.archived, description: r.description,
  language: r.language, default_branch: r.default_branch, stars: r.stargazers_count, open_issues: r.open_issues_count,
  pushed_at: r.pushed_at, url: r.html_url,
});

export function registerGithub(server: McpServer) {
  // ---------- discovery ----------
  tool(server, "github_repos", "List repositories the account can access (own, collaborator, org), most recently pushed first. Omit account for all GitHub accounts.",
    { account: accountOrAll, affiliation: z.string().default("owner,collaborator,organization_member"), per_page: perPage },
    ({ account: acc, affiliation, per_page }) =>
      fanOut("github", acc, async (label) =>
        (await gh(label, "/user/repos", { query: { affiliation, sort: "pushed", per_page } })).map(slimRepo)),
    { readOnly: true });

  tool(server, "github_search", "Search GitHub (repositories, issues/PRs, code, commits, users) using GitHub search syntax, e.g. 'is:open is:pr author:@me org:foo'. Omit account to search with every GitHub account (private repos each can see).",
    { account: accountOrAll, type: z.enum(["repositories", "issues", "code", "commits", "users"]), q: z.string(), per_page: z.number().int().min(1).max(50).default(20) },
    ({ account: acc, type, q, per_page }) =>
      fanOut("github", acc, async (label) => {
        const r = await gh(label, `/search/${type}`, { query: { q, per_page } });
        const items: any[] = r.items ?? [];
        const slim =
          type === "issues" ? items.map(slimIssue)
          : type === "repositories" ? items.map(slimRepo)
          : type === "code" ? items.map((x) => ({ repo: x.repository?.full_name, path: x.path, url: x.html_url }))
          : type === "commits" ? items.map((x) => ({ repo: x.repository?.full_name, sha: x.sha, message: x.commit?.message?.split("\n")[0], author: x.author?.login, date: x.commit?.author?.date, url: x.html_url }))
          : items.map((x) => ({ login: x.login, type: x.type, url: x.html_url }));
        return { total_count: r.total_count, items: slim };
      }),
    { readOnly: true });

  tool(server, "github_my_work", "Open issues/PRs involving the user: assigned to me, created by me, review requested from me, or mentioning me. Omit account for all GitHub accounts.",
    { account: accountOrAll, kind: z.enum(["assigned", "created", "review_requested", "mentioned"]), type: z.enum(["pr", "issue", "any"]).default("any") },
    ({ account: acc, kind, type }) =>
      fanOut("github", acc, async (label) => {
        const qual = { assigned: "assignee:@me", created: "author:@me", review_requested: "review-requested:@me", mentioned: "mentions:@me" }[kind];
        const t = type === "any" ? "" : ` is:${type === "pr" ? "pr" : "issue"}`;
        const r = await gh(label, "/search/issues", { query: { q: `is:open ${qual}${t} archived:false`, sort: "updated", per_page: 50 } });
        return (r.items ?? []).map(slimIssue);
      }),
    { readOnly: true });

  tool(server, "github_notifications", "GitHub notifications inbox (unread by default). Not available to GitHub App tokens (GitHub limitation) — needs an OAuth App connection with the `notifications` scope. Omit account for all GitHub accounts.",
    { account: accountOrAll, all: z.boolean().default(false).describe("Include read notifications"), participating: z.boolean().default(false) },
    ({ account: acc, all, participating }) =>
      fanOut("github", acc, async (label) =>
        (await gh(label, "/notifications", { query: { all, participating, per_page: 50 } })).map((n: any) => ({
          id: n.id, repo: n.repository?.full_name, reason: n.reason, unread: n.unread, updated: n.updated_at,
          title: n.subject?.title, type: n.subject?.type, api_url: n.subject?.url,
        }))),
    { readOnly: true });

  // ---------- code ----------
  tool(server, "github_get_file", "Read a file (decoded text) or list a directory in a repository.",
    { account, ...repoShape, path: z.string().default(""), ref: z.string().optional().describe("Branch, tag or commit; default branch if omitted") },
    async ({ account: label, path, ref, ...r }) => {
      const res = await gh(label, `${rp(r)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, { query: { ref } });
      if (Array.isArray(res)) return res.map((e: any) => ({ name: e.name, path: e.path, type: e.type, size: e.size }));
      if (res.encoding === "base64") return { path: res.path, sha: res.sha, size: res.size, content: Buffer.from(res.content, "base64").toString("utf8") };
      return res; // large files / submodules: metadata only (use github_api with the raw media type)
    },
    { readOnly: true });

  tool(server, "github_put_file", "Create or update a file with a commit (the sha of an existing file is looked up automatically).",
    { account, ...repoShape, path: z.string(), content: z.string().describe("New full file content (UTF-8)"), message: z.string().describe("Commit message"), branch: z.string().optional() },
    async ({ account: label, path, content, message, branch, ...r }) => {
      const url = `${rp(r)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
      const existing = await gh(label, url, { query: { ref: branch } }).catch(() => undefined);
      const res = await gh(label, url, {
        method: "PUT",
        body: { message, content: Buffer.from(content, "utf8").toString("base64"), branch, sha: existing && !Array.isArray(existing) ? existing.sha : undefined },
      });
      return { commit: res.commit?.sha, url: res.commit?.html_url, path: res.content?.path };
    },
    { destructive: true });

  tool(server, "github_commits", "List commits of a repository (optionally for a branch/path/author/date range).",
    { account, ...repoShape, sha: z.string().optional().describe("Branch or sha"), path: z.string().optional(), author: z.string().optional(), since: z.string().optional(), per_page: perPage },
    async ({ account: label, per_page, ...a }) =>
      (await gh(label, `${rp(a)}/commits`, { query: { sha: a.sha, path: a.path, author: a.author, since: a.since, per_page } })).map((c: any) => ({
        sha: c.sha.slice(0, 10), message: c.commit?.message?.split("\n")[0], author: c.author?.login ?? c.commit?.author?.name, date: c.commit?.author?.date, url: c.html_url,
      })),
    { readOnly: true });

  tool(server, "github_actions_runs", "Recent GitHub Actions workflow runs of a repository.",
    { account, ...repoShape, branch: z.string().optional(), status: z.string().optional().describe("e.g. failure, success, in_progress"), per_page: z.number().int().min(1).max(50).default(15) },
    async ({ account: label, branch, status, per_page, ...r }) =>
      ((await gh(label, `${rp(r)}/actions/runs`, { query: { branch, status, per_page } })).workflow_runs ?? []).map((w: any) => ({
        id: w.id, name: w.name, branch: w.head_branch, event: w.event, status: w.status, conclusion: w.conclusion, created: w.created_at, url: w.html_url,
      })),
    { readOnly: true });

  // ---------- issues ----------
  tool(server, "github_issues", "List issues in a repository (pull requests excluded).",
    { account, ...repoShape, state: z.enum(["open", "closed", "all"]).default("open"), labels: z.string().optional().describe("Comma-separated"), assignee: z.string().optional(), per_page: perPage },
    async ({ account: label, state, labels, assignee, per_page, ...r }) =>
      (await gh(label, `${rp(r)}/issues`, { query: { state, labels, assignee, per_page } })).filter((i: any) => !i.pull_request).map(slimIssue),
    { readOnly: true });

  tool(server, "github_issue", "Read an issue or pull request conversation: body plus comments.",
    { account, ...repoShape, number: num },
    async ({ account: label, number, ...r }) => {
      const [issue, comments] = await Promise.all([
        gh(label, `${rp(r)}/issues/${number}`),
        gh(label, `${rp(r)}/issues/${number}/comments`, { query: { per_page: 100 }, pages: 3 }),
      ]);
      return { ...slimIssue(issue), body: issue.body, comments_list: comments.map((c: any) => ({ author: c.user?.login, at: c.created_at, body: c.body })) };
    },
    { readOnly: true });

  tool(server, "github_create_issue", "Open a new issue.",
    { account, ...repoShape, title: z.string(), body: z.string().optional(), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional() },
    async ({ account: label, title, body, labels, assignees, ...r }) =>
      slimIssue(await gh(label, `${rp(r)}/issues`, { method: "POST", body: { title, body, labels, assignees } })));

  tool(server, "github_update_issue", "Edit an issue or PR: title, body, state (open/closed), labels, assignees.",
    { account, ...repoShape, number: num, title: z.string().optional(), body: z.string().optional(), state: z.enum(["open", "closed"]).optional(), labels: z.array(z.string()).optional().describe("Replaces all labels"), assignees: z.array(z.string()).optional().describe("Replaces all assignees") },
    async ({ account: label, number, ...rest }) => {
      const { owner, repo, ...patch } = rest;
      return slimIssue(await gh(label, `${rp({ owner, repo })}/issues/${number}`, { method: "PATCH", body: patch }));
    });

  tool(server, "github_comment", "Comment on an issue or pull request.",
    { account, ...repoShape, number: num, body: z.string() },
    async ({ account: label, number, body, ...r }) => {
      const c = await gh(label, `${rp(r)}/issues/${number}/comments`, { method: "POST", body: { body } });
      return { id: c.id, url: c.html_url };
    });

  // ---------- pull requests ----------
  tool(server, "github_prs", "List pull requests in a repository.",
    { account, ...repoShape, state: z.enum(["open", "closed", "all"]).default("open"), base: z.string().optional(), per_page: perPage },
    async ({ account: label, state, base, per_page, ...r }) =>
      (await gh(label, `${rp(r)}/pulls`, { query: { state, base, per_page } })).map((p: any) => ({
        number: p.number, title: p.title, state: p.state, draft: p.draft, author: p.user?.login, head: p.head?.ref, base: p.base?.ref,
        reviewers: p.requested_reviewers?.map((x: any) => x.login), created: p.created_at, updated: p.updated_at, url: p.html_url,
      })),
    { readOnly: true });

  tool(server, "github_pr", "Pull request details: description, mergeability, changed files (no patches; use github_pr_diff), and reviews.",
    { account, ...repoShape, number: num },
    async ({ account: label, number, ...r }) => {
      const base = `${rp(r)}/pulls/${number}`;
      const [pr, files, reviews] = await Promise.all([
        gh(label, base),
        gh(label, `${base}/files`, { query: { per_page: 100 }, pages: 3 }),
        gh(label, `${base}/reviews`, { query: { per_page: 100 } }),
      ]);
      return {
        number: pr.number, title: pr.title, state: pr.state, draft: pr.draft, merged: pr.merged, mergeable: pr.mergeable, mergeable_state: pr.mergeable_state,
        author: pr.user?.login, head: pr.head?.label, base: pr.base?.label, additions: pr.additions, deletions: pr.deletions, body: pr.body, url: pr.html_url,
        files: files.map((f: any) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
        reviews: reviews.map((v: any) => ({ author: v.user?.login, state: v.state, body: v.body })),
      };
    },
    { readOnly: true });

  tool(server, "github_pr_diff", "Unified diff of a pull request (truncated if very large).",
    { account, ...repoShape, number: num },
    ({ account: label, number, ...r }) => gh(label, `${rp(r)}/pulls/${number}`, { raw: true, headers: { accept: "application/vnd.github.diff" } }),
    { readOnly: true });

  tool(server, "github_create_pr", "Open a pull request.",
    { account, ...repoShape, title: z.string(), head: z.string().describe("Branch with changes (or owner:branch for forks)"), base: z.string().describe("Target branch"), body: z.string().optional(), draft: z.boolean().default(false) },
    async ({ account: label, title, head, base, body, draft, ...r }) => {
      const p = await gh(label, `${rp(r)}/pulls`, { method: "POST", body: { title, head, base, body, draft } });
      return { number: p.number, url: p.html_url };
    });

  tool(server, "github_review_pr", "Submit a pull request review (approve, request changes, or comment).",
    { account, ...repoShape, number: num, event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]), body: z.string().optional() },
    async ({ account: label, number, event, body, ...r }) => {
      const v = await gh(label, `${rp(r)}/pulls/${number}/reviews`, { method: "POST", body: { event, body } });
      return { id: v.id, state: v.state, url: v.html_url };
    },
    { destructive: true });

  tool(server, "github_merge_pr", "Merge a pull request. Irreversible: confirm with the user first.",
    { account, ...repoShape, number: num, method: z.enum(["merge", "squash", "rebase"]).default("squash"), commit_title: z.string().optional() },
    ({ account: label, number, method, commit_title, ...r }) =>
      gh(label, `${rp(r)}/pulls/${number}/merge`, { method: "PUT", body: { merge_method: method, commit_title } }),
    { destructive: true });

  // ---------- escape hatch ----------
  tool(server, "github_api", "Call any GitHub REST endpoint (api.github.com) with the account's token — releases, branches, gists, org/team admin, etc. `path` like /repos/o/r/branches. GET collections follow up to 3 pages.",
    { account, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.string(), z.string()).optional(), body: z.any().optional() },
    ({ account: label, method, path, query, body }) => gh(label, path, { method, query, body, pages: method === "GET" ? 3 : 1 }),
    { destructive: true });
}
