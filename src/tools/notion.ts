import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import { account, tool } from "./common.js";

const NT = "https://api.notion.com";
const nt = (label: string, path: string, opts: Parameters<typeof api>[3] = {}) => api(label, "notion", NT + path, opts);
const idOf = (s: string) => /([0-9a-f]{32})(?:[?#].*)?$/i.exec(s.replace(/-/g, ""))?.[1] ?? s;
const plain = (rt: any[] | undefined) => (rt ?? []).map((t) => t.plain_text).join("");

function titleOf(o: any): string {
  if (o.object === "database") return plain(o.title);
  for (const p of Object.values<any>(o.properties ?? {})) if (p.type === "title") return plain(p.title);
  return "";
}

// Flatten a property value to something readable
function propValue(p: any): unknown {
  switch (p.type) {
    case "title": return plain(p.title);
    case "rich_text": return plain(p.rich_text);
    case "number": case "checkbox": case "url": case "email": case "phone_number": return p[p.type];
    case "select": case "status": return p[p.type]?.name;
    case "multi_select": return p.multi_select.map((x: any) => x.name);
    case "date": return p.date ? (p.date.end ? `${p.date.start} → ${p.date.end}` : p.date.start) : null;
    case "people": return p.people.map((x: any) => x.name ?? x.id);
    case "relation": return p.relation.map((x: any) => x.id);
    default: return undefined;
  }
}
const slimRow = (o: any) => ({
  id: o.id, url: o.url, title: titleOf(o), edited: o.last_edited_time,
  properties: Object.fromEntries(Object.entries<any>(o.properties ?? {}).map(([k, v]) => [k, propValue(v)]).filter(([, v]) => v !== undefined && v !== null && v !== "")),
});

function blockText(b: any): string {
  const t = b[b.type];
  const text = plain(t?.rich_text);
  switch (b.type) {
    case "heading_1": return `# ${text}`;
    case "heading_2": return `## ${text}`;
    case "heading_3": return `### ${text}`;
    case "bulleted_list_item": return `- ${text}`;
    case "numbered_list_item": return `1. ${text}`;
    case "to_do": return `- [${t.checked ? "x" : " "}] ${text}`;
    case "quote": return `> ${text}`;
    case "code": return "```" + (t.language ?? "") + "\n" + text + "\n```";
    case "child_page": return `[page: ${t.title}] (${b.id})`;
    case "child_database": return `[database: ${t.title}] (${b.id})`;
    default: return text;
  }
}
const paragraphs = (text: string) =>
  text.split(/\n{2,}/).filter(Boolean).map((p) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: p.slice(0, 2000) } }] } }));

export function registerNotion(server: McpServer) {
  tool(server, "notion_search", "Search pages and databases shared with the integration.",
    { account, query: z.string().default(""), kind: z.enum(["page", "database", "any"]).default("any"), page_size: z.number().int().min(1).max(50).default(15) },
    async ({ account: label, query, kind, page_size }) =>
      (await nt(label, "/v1/search", { method: "POST", body: { query, page_size, ...(kind !== "any" ? { filter: { property: "object", value: kind } } : {}), sort: { direction: "descending", timestamp: "last_edited_time" } } })).results.map((o: any) => ({ id: o.id, type: o.object, title: titleOf(o), url: o.url, edited: o.last_edited_time })),
    { readOnly: true });

  tool(server, "notion_page", "Read a page: its properties and content as plain text/markdown (first 100 blocks; nested blocks are not expanded). Accepts an id or a notion.so URL.",
    { account, page: z.string() },
    async ({ account: label, page }) => {
      const id = idOf(page);
      const [p, blocks] = await Promise.all([nt(label, `/v1/pages/${id}`), nt(label, `/v1/blocks/${id}/children`, { query: { page_size: 100 } })]);
      return { ...slimRow(p), content: blocks.results.map(blockText).join("\n"), more_content: !!blocks.has_more };
    },
    { readOnly: true });

  tool(server, "notion_query_database", "Query a database. `filter` and `sorts` use Notion's API format (see developers.notion.com/reference/post-database-query-filter).",
    { account, database: z.string().describe("Database id or URL"), filter: z.any().optional(), sorts: z.array(z.any()).optional(), page_size: z.number().int().min(1).max(100).default(25), start_cursor: z.string().optional() },
    async ({ account: label, database, filter, sorts, page_size, start_cursor }) => {
      const r = await nt(label, `/v1/databases/${idOf(database)}/query`, { method: "POST", body: { filter, sorts, page_size, start_cursor } });
      return { rows: r.results.map(slimRow), next_cursor: r.next_cursor ?? undefined };
    },
    { readOnly: true });

  tool(server, "notion_create_page", "Create a page under a page or as a row in a database. For a database, pass `properties` in Notion's API format (the title property is filled from `title` if you omit it).",
    { account, parent: z.string().describe("Parent page or database id/URL"), parent_type: z.enum(["page", "database"]), title: z.string(), content: z.string().optional().describe("Body text; blank lines separate paragraphs"), properties: z.record(z.string(), z.any()).optional() },
    async ({ account: label, parent, parent_type, title, content, properties }) => {
      const id = idOf(parent);
      let props = properties;
      if (parent_type === "page") props = { title: { title: [{ text: { content: title } }] } };
      else if (!props) {
        const db = await nt(label, `/v1/databases/${id}`);
        const key = Object.entries<any>(db.properties).find(([, v]) => v.type === "title")?.[0] ?? "Name";
        props = { [key]: { title: [{ text: { content: title } }] } };
      }
      const r = await nt(label, "/v1/pages", { method: "POST", body: { parent: parent_type === "page" ? { page_id: id } : { database_id: id }, properties: props, ...(content ? { children: paragraphs(content) } : {}) } });
      return { id: r.id, url: r.url };
    },
    { destructive: true });

  tool(server, "notion_append_text", "Append paragraphs to the end of a page.",
    { account, page: z.string(), text: z.string().describe("Blank lines separate paragraphs") },
    async ({ account: label, page, text }) => {
      await nt(label, `/v1/blocks/${idOf(page)}/children`, { method: "PATCH", body: { children: paragraphs(text) } });
      return { ok: true };
    },
    { destructive: true });

  tool(server, "notion_api", "Call any Notion REST endpoint (api.notion.com), e.g. update page properties with PATCH /v1/pages/{id}, comments, users.",
    { account, method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET"), path: z.string().describe("e.g. /v1/comments?block_id=…"), body: z.any().optional() },
    ({ account: label, method, path, body }) => nt(label, path, { method, body }),
    { destructive: true });
}
