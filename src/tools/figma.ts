import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import { account, tool } from "./common.js";

const FG = "https://api.figma.com";
const fg = (label: string, path: string, opts: Parameters<typeof api>[3] = {}) => api(label, "figma", FG + path, opts);
const file = z.string().describe("File key or a figma.com/file|design/<key>/… URL");
const key = (s: string) => /figma\.com\/(?:file|design|board|proto)\/([A-Za-z0-9]+)/.exec(s)?.[1] ?? s;

function slimNode(n: any, depth: number): any {
  const o: any = { id: n.id, name: n.name, type: n.type };
  if (n.characters) o.text = n.characters.slice(0, 500);
  if (depth > 0 && n.children) o.children = n.children.map((c: any) => slimNode(c, depth - 1));
  else if (n.children) o.children = n.children.length;
  return o;
}

export function registerFigma(server: McpServer) {
  tool(server, "figma_file", "Get the structure of a Figma file as a trimmed tree (pages → frames → layers, names/types/text). Use node_ids for a subtree and raise depth for more detail.",
    { account, file, depth: z.number().int().min(1).max(6).default(2), node_ids: z.array(z.string()).optional() },
    async ({ account: label, file: f, depth, node_ids }) => {
      const k = key(f);
      if (node_ids?.length) {
        const r = await fg(label, `/v1/files/${k}/nodes`, { query: { ids: node_ids.join(","), depth: depth + 1 } });
        return Object.fromEntries(Object.entries(r.nodes ?? {}).map(([id, v]: [string, any]) => [id, slimNode(v.document, depth)]));
      }
      const r = await fg(label, `/v1/files/${k}`, { query: { depth: depth + 1 } });
      return { name: r.name, last_modified: r.lastModified, version: r.version, document: slimNode(r.document, depth) };
    },
    { readOnly: true });

  tool(server, "figma_projects", "List a team's projects, or the files of a project. Provide team_id or project_id (both visible in figma.com URLs).",
    { account, team_id: z.string().optional(), project_id: z.string().optional() },
    async ({ account: label, team_id, project_id }) => {
      if (project_id) return ((await fg(label, `/v1/projects/${project_id}/files`)).files ?? []).map((x: any) => ({ key: x.key, name: x.name, modified: x.last_modified }));
      if (team_id) return ((await fg(label, `/v1/teams/${team_id}/projects`)).projects ?? []).map((x: any) => ({ id: x.id, name: x.name }));
      throw new Error("Provide team_id or project_id");
    },
    { readOnly: true });

  tool(server, "figma_comments", "List comments on a file.",
    { account, file },
    async ({ account: label, file: f }) =>
      ((await fg(label, `/v1/files/${key(f)}/comments`)).comments ?? []).map((c: any) => ({
        id: c.id, parent_id: c.parent_id || undefined, author: c.user?.handle, time: c.created_at, resolved: !!c.resolved_at, message: c.message, node: c.client_meta?.node_id,
      })),
    { readOnly: true });

  tool(server, "figma_post_comment", "Post a comment on a file (optionally a reply). Visible to collaborators: confirm with the user first.",
    { account, file, message: z.string(), reply_to: z.string().optional().describe("Comment id to reply to"), node_id: z.string().optional(), x: z.number().default(0), y: z.number().default(0) },
    ({ account: label, file: f, message, reply_to, node_id, x, y }) =>
      fg(label, `/v1/files/${key(f)}/comments`, { method: "POST", body: { message, ...(reply_to ? { comment_id: reply_to } : { client_meta: node_id ? { node_id, node_offset: { x, y } } : { x, y } }) } }),
    { destructive: true });

  tool(server, "figma_images", "Render nodes of a file to images and return temporary download URLs.",
    { account, file, node_ids: z.array(z.string()).min(1), format: z.enum(["png", "svg", "jpg", "pdf"]).default("png"), scale: z.number().min(0.01).max(4).default(2) },
    async ({ account: label, file: f, node_ids, format, scale }) =>
      (await fg(label, `/v1/images/${key(f)}`, { query: { ids: node_ids.join(","), format, scale } })).images,
    { readOnly: true });

  tool(server, "figma_api", "Call any Figma REST endpoint (api.figma.com) — variables, components, styles, dev resources, etc. `path` like /v1/files/{key}/components.",
    { account, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.string(), z.string()).optional(), body: z.any().optional() },
    ({ account: label, method, path, query, body }) => fg(label, path, { method, query, body }),
    { destructive: true });
}
