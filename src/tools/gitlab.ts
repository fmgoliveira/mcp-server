import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import { getAccount } from "../store.js";
import { DEFAULT_GITLAB } from "../tokens.js";
import { account, accountOrAll, fanOut, tool } from "./common.js";

const gl = (label: string, path: string, opts: Parameters<typeof api>[3] = {}) => {
  const base = getAccount(label).baseUrl ?? DEFAULT_GITLAB;
  return api(label, "gitlab", path.startsWith("http") ? path : `${base}/api/v4${path}`, opts);
};
const project = z.string().describe('Project id or full path, e.g. "group/sub/project"');
const pid = (p: string) => encodeURIComponent(p);
const perPage = z.number().int().min(1).max(100).default(30);

const slimMr = (m: any) => ({
  iid: m.iid, title: m.title, state: m.state, draft: m.draft, author: m.author?.username, source: m.source_branch, target: m.target_branch,
  project: m.references?.full?.replace(/!\d+$/, ""), labels: m.labels, updated: m.updated_at, url: m.web_url,
});
const slimIssue = (i: any) => ({
  iid: i.iid, title: i.title, state: i.state, author: i.author?.username, assignees: i.assignees?.map((a: any) => a.username),
  labels: i.labels, project: i.references?.full?.replace(/#\d+$/, ""), updated: i.updated_at, url: i.web_url,
});

export function registerGitlab(server: McpServer) {
  tool(server, "gitlab_projects", "List GitLab projects the account is a member of, most recently active first. Omit account for all GitLab accounts.",
    { account: accountOrAll, search: z.string().optional(), per_page: perPage },
    ({ account: acc, search, per_page }) =>
      fanOut("gitlab", acc, async (label) =>
        (await gl(label, "/projects", { query: { membership: true, order_by: "last_activity_at", search, per_page } })).map((p: any) => ({
          id: p.id, path: p.path_with_namespace, visibility: p.visibility, default_branch: p.default_branch, archived: p.archived, last_activity: p.last_activity_at, url: p.web_url,
        }))),
    { readOnly: true });

  tool(server, "gitlab_merge_requests", "List merge requests: across the account (scope) or within one project. Omit account for all GitLab accounts.",
    { account: accountOrAll, project: project.optional(), state: z.enum(["opened", "closed", "merged", "all"]).default("opened"), scope: z.enum(["created_by_me", "assigned_to_me", "all"]).default("all"), per_page: perPage },
    ({ account: acc, project: p, state, scope, per_page }) =>
      fanOut("gitlab", acc, async (label) =>
        (await gl(label, p ? `/projects/${pid(p)}/merge_requests` : "/merge_requests", { query: { state, scope, per_page } })).map(slimMr)),
    { readOnly: true });

  tool(server, "gitlab_issues", "List issues across the account or within one project. Omit account for all GitLab accounts.",
    { account: accountOrAll, project: project.optional(), state: z.enum(["opened", "closed", "all"]).default("opened"), scope: z.enum(["created_by_me", "assigned_to_me", "all"]).default("all"), search: z.string().optional(), per_page: perPage },
    ({ account: acc, project: p, state, scope, search, per_page }) =>
      fanOut("gitlab", acc, async (label) =>
        (await gl(label, p ? `/projects/${pid(p)}/issues` : "/issues", { query: { state, scope, search, per_page } })).map(slimIssue)),
    { readOnly: true });

  tool(server, "gitlab_mr", "Get one merge request with its changed files (diff paths + diffs, truncated).",
    { account, project, iid: z.number().int() },
    async ({ account: label, project: p, iid }) => {
      const base = `/projects/${pid(p)}/merge_requests/${iid}`;
      const [mr, changes] = await Promise.all([gl(label, base), gl(label, `${base}/changes`)]);
      return { ...slimMr(mr), description: mr.description, merge_status: mr.detailed_merge_status, pipeline: mr.head_pipeline?.status,
        files: (changes.changes ?? []).map((c: any) => ({ old: c.old_path, new: c.new_path, diff: String(c.diff ?? "").slice(0, 4000) })) };
    },
    { readOnly: true });

  tool(server, "gitlab_create_mr", "Create a merge request.",
    { account, project, source_branch: z.string(), target_branch: z.string(), title: z.string(), description: z.string().optional(), draft: z.boolean().default(false), remove_source_branch: z.boolean().default(false) },
    async ({ account: label, project: p, draft, title, ...rest }) =>
      slimMr(await gl(label, `/projects/${pid(p)}/merge_requests`, { method: "POST", body: { ...rest, title: draft ? `Draft: ${title}` : title } })),
    { destructive: true });

  tool(server, "gitlab_comment", "Comment on a merge request or issue.",
    { account, project, kind: z.enum(["merge_request", "issue"]), iid: z.number().int(), body: z.string() },
    ({ account: label, project: p, kind, iid, body }) =>
      gl(label, `/projects/${pid(p)}/${kind === "issue" ? "issues" : "merge_requests"}/${iid}/notes`, { method: "POST", body: { body } }),
    { destructive: true });

  tool(server, "gitlab_merge_mr", "Merge a merge request. Irreversible: confirm with the user first.",
    { account, project, iid: z.number().int(), squash: z.boolean().default(false), remove_source_branch: z.boolean().default(false) },
    ({ account: label, project: p, iid, ...body }) => gl(label, `/projects/${pid(p)}/merge_requests/${iid}/merge`, { method: "PUT", body }),
    { destructive: true });

  tool(server, "gitlab_pipelines", "List recent pipelines of a project.",
    { account, project, ref: z.string().optional(), status: z.string().optional(), per_page: perPage },
    async ({ account: label, project: p, ref, status, per_page }) =>
      (await gl(label, `/projects/${pid(p)}/pipelines`, { query: { ref, status, per_page } })).map((x: any) => ({ id: x.id, status: x.status, ref: x.ref, sha: x.sha?.slice(0, 8), created: x.created_at, url: x.web_url })),
    { readOnly: true });

  tool(server, "gitlab_api", "Call any GitLab REST endpoint (/api/v4 of the account's instance) — files, branches, commits, groups, jobs, etc. `path` like /projects/123/repository/branches. GET collections follow up to 3 pages.",
    { account, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.string(), z.string()).optional(), body: z.any().optional() },
    ({ account: label, method, path, query, body }) => gl(label, path, { method, query, body, pages: method === "GET" ? 3 : 1 }),
    { destructive: true });
}
