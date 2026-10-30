import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import { account, accountOrAll, fanOut, tool } from "./common.js";

const gql = async (label: string, query: string, variables: Record<string, unknown> = {}) => {
  const r = await api(label, "linear", "https://api.linear.app/graphql", { method: "POST", body: { query, variables } });
  if (r?.errors?.length) throw new Error(`Linear: ${r.errors.map((e: any) => e.message).join("; ")}`);
  return r.data;
};
const ISSUE_FIELDS = "id identifier title url priorityLabel updatedAt state { name } assignee { name } team { key } labels { nodes { name } }";
const slim = (i: any) => ({ id: i.identifier, title: i.title, state: i.state?.name, priority: i.priorityLabel, assignee: i.assignee?.name, team: i.team?.key, labels: i.labels?.nodes?.map((l: any) => l.name), updated: i.updatedAt, url: i.url });
const priority = z.number().int().min(0).max(4).optional().describe("0 none, 1 urgent, 2 high, 3 medium, 4 low");

async function teamId(label: string, team: string): Promise<string> {
  const d = await gql(label, "{ teams(first: 100) { nodes { id key name } } }");
  const t = d.teams.nodes.find((x: any) => x.id === team || x.key.toLowerCase() === team.toLowerCase() || x.name.toLowerCase() === team.toLowerCase());
  if (!t) throw new Error(`Unknown Linear team "${team}". Teams: ${d.teams.nodes.map((x: any) => x.key).join(", ")}`);
  return t.id;
}

export function registerLinear(server: McpServer) {
  tool(server, "linear_issues", "List or search issues. Omit account for all Linear workspaces.",
    { account: accountOrAll, query: z.string().optional().describe("Text to find in titles"), team: z.string().optional().describe("Team key, e.g. ENG"), state: z.string().optional().describe("State name, e.g. In Progress"), assigned_to_me: z.boolean().default(false), include_done: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(25) },
    ({ account: acc, query, team, state, assigned_to_me, include_done, limit }) =>
      fanOut("linear", acc, async (label) => {
        const filter: any = {};
        if (query) filter.title = { containsIgnoreCase: query };
        if (team) filter.team = { key: { eqIgnoreCase: team } };
        if (state) filter.state = { name: { eqIgnoreCase: state } };
        else if (!include_done) filter.state = { type: { nin: ["completed", "canceled"] } };
        if (assigned_to_me) filter.assignee = { isMe: { eq: true } };
        const d = await gql(label, `query($filter: IssueFilter, $n: Int) { issues(filter: $filter, first: $n, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } } }`, { filter, n: limit });
        return d.issues.nodes.map(slim);
      }),
    { readOnly: true });

  tool(server, "linear_issue", "One issue with its description and recent comments. `id` is the identifier, e.g. ENG-123.",
    { account, id: z.string() },
    async ({ account: label, id }) => {
      const d = await gql(label, `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} description comments(first: 20) { nodes { body createdAt user { name } } } } }`, { id });
      return { ...slim(d.issue), description: d.issue.description, comments: d.issue.comments.nodes.map((c: any) => ({ author: c.user?.name, time: c.createdAt, body: c.body })) };
    },
    { readOnly: true });

  tool(server, "linear_teams", "List teams with their workflow states.",
    { account },
    async ({ account: label }) =>
      (await gql(label, "{ teams(first: 100) { nodes { key name states { nodes { name type } } } } }")).teams.nodes.map((t: any) => ({ key: t.key, name: t.name, states: t.states.nodes.map((s: any) => s.name) })),
    { readOnly: true });

  tool(server, "linear_create_issue", "Create an issue.",
    { account, team: z.string().describe("Team key, name or id"), title: z.string(), description: z.string().optional(), priority, assign_to_me: z.boolean().default(false) },
    async ({ account: label, team, title, description, priority: pr, assign_to_me }) => {
      const input: any = { teamId: await teamId(label, team), title, description, priority: pr };
      if (assign_to_me) input.assigneeId = (await gql(label, "{ viewer { id } }")).viewer.id;
      const d = await gql(label, `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`, { input });
      return slim(d.issueCreate.issue);
    },
    { destructive: true });

  tool(server, "linear_update_issue", "Change an issue's title, description, state (by name), priority or assignee.",
    { account, id: z.string().describe("Identifier, e.g. ENG-123"), title: z.string().optional(), description: z.string().optional(), state: z.string().optional().describe("State name, e.g. Done"), priority, assign_to_me: z.boolean().optional() },
    async ({ account: label, id, title, description, state, priority: pr, assign_to_me }) => {
      const cur = (await gql(label, `query($id: String!) { issue(id: $id) { id team { states { nodes { id name } } } } }`, { id })).issue;
      const input: any = { title, description, priority: pr };
      if (state) {
        const s = cur.team.states.nodes.find((x: any) => x.name.toLowerCase() === state.toLowerCase());
        if (!s) throw new Error(`Unknown state "${state}". Options: ${cur.team.states.nodes.map((x: any) => x.name).join(", ")}`);
        input.stateId = s.id;
      }
      if (assign_to_me) input.assigneeId = (await gql(label, "{ viewer { id } }")).viewer.id;
      const d = await gql(label, `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { ${ISSUE_FIELDS} } } }`, { id: cur.id, input });
      return slim(d.issueUpdate.issue);
    },
    { destructive: true });

  tool(server, "linear_comment", "Comment on an issue (markdown).",
    { account, id: z.string().describe("Identifier, e.g. ENG-123"), body: z.string() },
    async ({ account: label, id, body }) => {
      const issueId = (await gql(label, `query($id: String!) { issue(id: $id) { id } }`, { id })).issue.id;
      await gql(label, `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`, { input: { issueId, body } });
      return { ok: true };
    },
    { destructive: true });

  tool(server, "linear_api", "Run any GraphQL query or mutation against Linear's API.",
    { account, query: z.string(), variables: z.record(z.string(), z.any()).optional() },
    ({ account: label, query, variables }) => gql(label, query, variables ?? {}),
    { destructive: true });
}
