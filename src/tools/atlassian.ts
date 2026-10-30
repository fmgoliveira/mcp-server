import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import { getAccount } from "../store.js";
import { account, accountOrAll, fanOut, tool } from "./common.js";

// Jira and Confluence Cloud through one site URL + email + API token (Basic auth).
const at = (label: string, path: string, opts: Parameters<typeof api>[3] = {}) => {
  const base = getAccount(label).baseUrl;
  if (!base) throw new Error(`Account "${label}" has no site URL`);
  return api(label, "atlassian", base + path, opts);
};

// Jira stores rich text as Atlassian Document Format (ADF)
function adfText(n: any): string {
  if (!n) return "";
  if (typeof n === "string") return n;
  if (n.type === "text") return n.text ?? "";
  if (n.type === "hardBreak") return "\n";
  const inner = (n.content ?? []).map(adfText).join(n.type === "doc" || n.type === "bulletList" || n.type === "orderedList" ? "\n" : "");
  return n.type === "listItem" ? `- ${inner}` : inner;
}
const toAdf = (text: string) => ({
  type: "doc", version: 1,
  content: text.split(/\n{2,}/).filter(Boolean).map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })),
});
const stripHtml = (h: string) => h.replace(/<(br|\/p|\/h\d|\/li|\/tr)\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n{3,}/g, "\n\n").trim();

const slimIssue = (i: any, base?: string) => ({
  key: i.key, summary: i.fields?.summary, status: i.fields?.status?.name, type: i.fields?.issuetype?.name, priority: i.fields?.priority?.name,
  assignee: i.fields?.assignee?.displayName, project: i.fields?.project?.key, updated: i.fields?.updated, url: base ? `${base}/browse/${i.key}` : undefined,
});
const FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "project", "updated"];

export function registerAtlassian(server: McpServer) {
  tool(server, "jira_search", "Search Jira issues with JQL, e.g. `assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC`. Omit account for all Atlassian sites.",
    { account: accountOrAll, jql: z.string(), max_results: z.number().int().min(1).max(100).default(25) },
    ({ account: acc, jql, max_results }) =>
      fanOut("atlassian", acc, async (label) => {
        const r = await at(label, "/rest/api/3/search/jql", { method: "POST", body: { jql, maxResults: max_results, fields: FIELDS } });
        const base = getAccount(label).baseUrl;
        return r.issues.map((i: any) => slimIssue(i, base));
      }),
    { readOnly: true });

  tool(server, "jira_issue", "One Jira issue with description and recent comments.",
    { account, key: z.string().describe("Issue key, e.g. PROJ-42") },
    async ({ account: label, key }) => {
      const i = await at(label, `/rest/api/3/issue/${encodeURIComponent(key)}`, { query: { fields: [...FIELDS, "description", "comment", "labels"].join(",") } });
      return {
        ...slimIssue(i, getAccount(label).baseUrl), labels: i.fields.labels, description: adfText(i.fields.description),
        comments: (i.fields.comment?.comments ?? []).slice(-10).map((c: any) => ({ author: c.author?.displayName, time: c.created, body: adfText(c.body) })),
      };
    },
    { readOnly: true });

  tool(server, "jira_create_issue", "Create a Jira issue.",
    { account, project_key: z.string(), summary: z.string(), description: z.string().optional(), issue_type: z.string().default("Task"), labels: z.array(z.string()).optional() },
    async ({ account: label, project_key, summary, description, issue_type, labels }) => {
      const r = await at(label, "/rest/api/3/issue", { method: "POST", body: { fields: { project: { key: project_key }, summary, issuetype: { name: issue_type }, ...(description ? { description: toAdf(description) } : {}), ...(labels ? { labels } : {}) } } });
      return { key: r.key, url: `${getAccount(label).baseUrl}/browse/${r.key}` };
    },
    { destructive: true });

  tool(server, "jira_comment", "Comment on a Jira issue.",
    { account, key: z.string(), body: z.string() },
    async ({ account: label, key, body }) => {
      await at(label, `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { method: "POST", body: { body: toAdf(body) } });
      return { ok: true };
    },
    { destructive: true });

  tool(server, "jira_transition", "Move a Jira issue to another status by name (e.g. \"In Progress\", \"Done\"). Lists the valid names if it doesn't match.",
    { account, key: z.string(), status: z.string() },
    async ({ account: label, key, status }) => {
      const path = `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
      const { transitions } = await at(label, path);
      const t = transitions.find((x: any) => x.name.toLowerCase() === status.toLowerCase() || x.to?.name?.toLowerCase() === status.toLowerCase());
      if (!t) throw new Error(`No transition to "${status}". Available: ${transitions.map((x: any) => x.to?.name ?? x.name).join(", ")}`);
      await at(label, path, { method: "POST", body: { transition: { id: t.id } } });
      return { ok: true, status: t.to?.name ?? t.name };
    },
    { destructive: true });

  tool(server, "confluence_search", "Search Confluence pages. `query` is plain text, or CQL if it contains operators like `space =` or `type =`. Omit account for all Atlassian sites.",
    { account: accountOrAll, query: z.string(), limit: z.number().int().min(1).max(50).default(15) },
    ({ account: acc, query, limit }) =>
      fanOut("atlassian", acc, async (label) => {
        const cql = /\b(space|type|label|creator|title|text|ancestor)\s*(=|~|in)\b/i.test(query) ? query : `siteSearch ~ "${query.replace(/"/g, '\\"')}" AND type = page`;
        const r = await at(label, "/wiki/rest/api/search", { query: { cql, limit } });
        return r.results.map((x: any) => ({ id: x.content?.id, title: x.title, space: x.resultGlobalContainer?.title, excerpt: stripHtml(x.excerpt ?? "").slice(0, 300), modified: x.lastModified, url: x.url ? getAccount(label).baseUrl + "/wiki" + x.url : undefined }));
      }),
    { readOnly: true });

  tool(server, "confluence_page", "Read a Confluence page as plain text.",
    { account, id: z.string().describe("Page id (from confluence_search or the page URL)") },
    async ({ account: label, id }) => {
      const p = await at(label, `/wiki/rest/api/content/${encodeURIComponent(id)}`, { query: { expand: "body.storage,version,space" } });
      return { id: p.id, title: p.title, space: p.space?.key, version: p.version?.number, updated: p.version?.when, text: stripHtml(p.body?.storage?.value ?? "") };
    },
    { readOnly: true });

  tool(server, "atlassian_api", "Call any Jira or Confluence Cloud REST endpoint on the account's site. `path` like /rest/api/3/project or /wiki/rest/api/space.",
    { account, method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.string(), z.string()).optional(), body: z.any().optional() },
    ({ account: label, method, path, query, body }) => at(label, path, { method, query, body }),
    { destructive: true });
}
