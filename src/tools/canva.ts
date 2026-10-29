import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import { account, accountOrAll, fanOut, tool } from "./common.js";

const BASE = "https://api.canva.com/rest/v1";
const cv = (label: string, path: string, opts: Parameters<typeof api>[3] = {}) =>
  api(label, "canva", path.startsWith("http") ? path : BASE + path, opts);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll an async Canva job (`GET <path>/<id>` → { job: { status } }) until it succeeds, fails or times out. */
async function pollJob(label: string, path: string, id: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const { job } = await cv(label, `${path}/${id}`);
    if (job.status === "success") return job;
    if (job.status === "failed") throw new Error(`Canva job failed: ${JSON.stringify(job.error ?? job)}`);
    if (Date.now() > end) return { ...job, note: `Still ${job.status}; check again with the job id` };
    await sleep(1500);
  }
}

const slimDesign = (d: any) => ({
  id: d.id, title: d.title, pages: d.page_count, created: d.created_at, updated: d.updated_at,
  edit_url: d.urls?.edit_url, view_url: d.urls?.view_url, thumbnail: d.thumbnail?.url,
});

export function registerCanva(server: McpServer) {
  tool(server, "canva_designs", "List or search Canva designs. Omit account to search every Canva account. Pass `continuation` from a previous result for the next page.",
    { account: accountOrAll, query: z.string().optional(), ownership: z.enum(["any", "owned", "shared"]).default("any"), sort_by: z.enum(["relevance", "modified_descending", "modified_ascending", "title_descending", "title_ascending"]).default("modified_descending"), limit: z.number().int().min(1).max(100).default(25), continuation: z.string().optional() },
    ({ account: acc, query, ownership, sort_by, limit, continuation }) =>
      fanOut("canva", acc, async (label) => {
        const r = await cv(label, "/designs", { query: { query, ownership, sort_by, limit, continuation } });
        return { items: (r.items ?? []).map(slimDesign), continuation: r.continuation };
      }),
    { readOnly: true });

  tool(server, "canva_design", "Get one design's metadata and page thumbnails.",
    { account, design_id: z.string() },
    async ({ account: label, design_id }) => {
      const [d, pages] = await Promise.all([
        cv(label, `/designs/${design_id}`),
        cv(label, `/designs/${design_id}/pages`, { query: { limit: 50 } }).catch(() => ({ items: [] })),
      ]);
      return { ...slimDesign(d.design), page_thumbnails: (pages.items ?? []).map((p: any) => ({ index: p.index, thumbnail: p.thumbnail?.url })) };
    },
    { readOnly: true });

  tool(server, "canva_create_design", "Create a new blank design (preset: doc, whiteboard, presentation; or custom pixel size 40-8000), optionally titled or seeded with an image asset. Returns an edit URL to open in Canva.",
    { account, preset: z.enum(["doc", "whiteboard", "presentation"]).optional(), width: z.number().int().min(40).max(8000).optional(), height: z.number().int().min(40).max(8000).optional(), title: z.string().optional(), asset_id: z.string().optional().describe("Image asset to place in the design") },
    async ({ account: label, preset, width, height, title, asset_id }) => {
      let design_type: unknown;
      if (preset) design_type = { type: "preset", name: preset };
      else if (width && height) design_type = { type: "custom", width, height };
      else throw new Error("Provide a preset, or both width and height");
      const r = await cv(label, "/designs", { method: "POST", body: { design_type, title, asset_id } });
      return slimDesign(r.design);
    });

  tool(server, "canva_export", "Export a design to pdf, png, jpg, gif, pptx or mp4 and return temporary download URLs (valid ~24h). Waits up to 60s for the export job.",
    { account, design_id: z.string(), format: z.enum(["pdf", "png", "jpg", "gif", "pptx", "mp4"]).default("pdf"), pages: z.array(z.number().int().min(1)).optional().describe("1-based page numbers; default all") },
    async ({ account: label, design_id, format, pages }) => {
      const r = await cv(label, "/exports", { method: "POST", body: { design_id, format: { type: format, ...(pages ? { pages } : {}) } } });
      const job = await pollJob(label, "/exports", r.job.id);
      return { job_id: job.id, status: job.status, urls: job.urls, note: job.note };
    });

  tool(server, "canva_export_status", "Check an export job started earlier (use when canva_export timed out).",
    { account, job_id: z.string() },
    ({ account: label, job_id }) => cv(label, `/exports/${job_id}`).then((r) => r.job),
    { readOnly: true });

  tool(server, "canva_folder_items", "List items (designs, folders, images) in a Canva folder. Use folder_id 'root' for the top level, or 'uploads' for uploaded assets.",
    { account, folder_id: z.string().default("root"), item_types: z.array(z.enum(["design", "folder", "image"])).optional(), limit: z.number().int().min(1).max(100).default(50), continuation: z.string().optional() },
    async ({ account: label, folder_id, item_types, limit, continuation }) => {
      const r = await cv(label, `/folders/${encodeURIComponent(folder_id)}/items`, { query: { item_types: item_types?.join(","), limit, continuation } });
      return {
        items: (r.items ?? []).map((i: any) => (i.design ? { type: "design", ...slimDesign(i.design) } : i.folder ? { type: "folder", id: i.folder.id, name: i.folder.name } : { type: i.type, ...(i.image ?? i) })),
        continuation: r.continuation,
      };
    },
    { readOnly: true });

  tool(server, "canva_create_folder", "Create a folder (parent_folder_id 'root' for top level).",
    { account, name: z.string(), parent_folder_id: z.string().default("root") },
    ({ account: label, name, parent_folder_id }) => cv(label, "/folders", { method: "POST", body: { name, parent_folder_id } }).then((r) => r.folder));

  tool(server, "canva_get_asset", "Get an uploaded asset's metadata (name, tags, thumbnail).",
    { account, asset_id: z.string() },
    ({ account: label, asset_id }) => cv(label, `/assets/${asset_id}`).then((r) => r.asset),
    { readOnly: true });

  tool(server, "canva_upload_asset_from_url", "Upload an image/video/audio into Canva's library from a public URL. Returns the asset (use its id with canva_create_design). Waits up to 60s.",
    { account, name: z.string().describe("Asset name (max 50 chars)"), url: z.string().describe("Public https URL of the file") },
    async ({ account: label, name, url }) => {
      const r = await cv(label, "/url-asset-uploads", { method: "POST", body: { name: name.slice(0, 50), url } });
      const job = await pollJob(label, "/url-asset-uploads", r.job.id);
      return { job_id: job.id, status: job.status, asset: job.asset, note: job.note };
    });

  tool(server, "canva_brand_templates", "List brand templates (Canva Enterprise only). Use with canva_autofill.",
    { account, query: z.string().optional(), limit: z.number().int().min(1).max(100).default(25), continuation: z.string().optional() },
    async ({ account: label, query, limit, continuation }) => {
      const r = await cv(label, "/brand-templates", { query: { query, limit, continuation } });
      return { items: (r.items ?? []).map((t: any) => ({ id: t.id, title: t.title, view_url: t.view_url, create_url: t.create_url, updated: t.updated_at })), continuation: r.continuation };
    },
    { readOnly: true });

  tool(server, "canva_autofill", "Create a design from a brand template by filling its data fields (Canva Enterprise only). `data` maps field name → {type:'text',text} | {type:'image',asset_id} | {type:'chart',chart_data}. Waits up to 60s.",
    { account, brand_template_id: z.string(), title: z.string().optional(), data: z.record(z.string(), z.any()) },
    async ({ account: label, brand_template_id, title, data }) => {
      const r = await cv(label, "/autofills", { method: "POST", body: { brand_template_id, title, data } });
      const job = await pollJob(label, "/autofills", r.job.id);
      return { job_id: job.id, status: job.status, design: job.result?.design && slimDesign(job.result.design), note: job.note };
    });

  tool(server, "canva_api", "Call any Canva Connect endpoint (api.canva.com/rest/v1) with the account's token — comments, resize, etc., limited to the scopes granted at connection. `path` is relative to /rest/v1.",
    { account, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.string(), z.string()).optional(), body: z.any().optional() },
    ({ account: label, method, path, query, body }) => cv(label, path, { method, query, body }),
    { destructive: true });
}
