import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "../api.js";
import { account, accountOrAll, fanOut, tool } from "./common.js";

const CF = "https://api.cloudflare.com/client/v4";
async function cf(label: string, path: string, opts: Parameters<typeof api>[3] = {}) {
  const r = await api(label, "cloudflare", path.startsWith("http") ? path : CF + path, opts);
  if (r && r.success === false) throw new Error(`Cloudflare: ${JSON.stringify(r.errors)}`);
  return r;
}
const zone = z.string().describe("Zone id (from cloudflare_zones)");
const slimRec = (r: any) => ({ id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied, priority: r.priority, comment: r.comment });
const dnsBody = {
  type: z.string().describe("A, AAAA, CNAME, MX, TXT, …"), name: z.string().describe("Record name, e.g. app.example.com or @"), content: z.string(),
  ttl: z.number().int().default(1).describe("1 = automatic"), proxied: z.boolean().optional(), priority: z.number().int().optional(), comment: z.string().optional(),
};

export function registerCloudflare(server: McpServer) {
  tool(server, "cloudflare_zones", "List Cloudflare zones (domains) the token can see. Omit account for all Cloudflare accounts.",
    { account: accountOrAll, name: z.string().optional() },
    ({ account: acc, name }) =>
      fanOut("cloudflare", acc, async (label) =>
        ((await cf(label, "/zones", { query: { name, per_page: 50 } })).result ?? []).map((z: any) => ({ id: z.id, name: z.name, status: z.status, plan: z.plan?.name, account: z.account?.name }))),
    { readOnly: true });

  tool(server, "cloudflare_dns_list", "List DNS records of a zone.",
    { account, zone_id: zone, type: z.string().optional(), name: z.string().optional() },
    async ({ account: label, zone_id, type, name }) =>
      ((await cf(label, `/zones/${zone_id}/dns_records`, { query: { type, name, per_page: 100 } })).result ?? []).map(slimRec),
    { readOnly: true });

  tool(server, "cloudflare_dns_create", "Create a DNS record. Changes live DNS: confirm with the user first.",
    { account, zone_id: zone, ...dnsBody },
    async ({ account: label, zone_id, ...body }) => slimRec((await cf(label, `/zones/${zone_id}/dns_records`, { method: "POST", body })).result),
    { destructive: true });

  tool(server, "cloudflare_dns_update", "Replace a DNS record (full overwrite of type/name/content/ttl/proxied). Changes live DNS: confirm first.",
    { account, zone_id: zone, record_id: z.string(), ...dnsBody },
    async ({ account: label, zone_id, record_id, ...body }) => slimRec((await cf(label, `/zones/${zone_id}/dns_records/${record_id}`, { method: "PUT", body })).result),
    { destructive: true });

  tool(server, "cloudflare_dns_delete", "Delete a DNS record. Irreversible: confirm with the user first.",
    { account, zone_id: zone, record_id: z.string() },
    async ({ account: label, zone_id, record_id }) => (await cf(label, `/zones/${zone_id}/dns_records/${record_id}`, { method: "DELETE" })).result,
    { destructive: true });

  tool(server, "cloudflare_api", "Call any Cloudflare v4 API endpoint (api.cloudflare.com/client/v4) — SSL, firewall/WAF rules, workers, pages, cache purge, etc. `path` like /zones/{id}/settings. Limited to the token's permissions.",
    { account, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), path: z.string(), query: z.record(z.string(), z.string()).optional(), body: z.any().optional() },
    ({ account: label, method, path, query, body }) => cf(label, path, { method, query, body }),
    { destructive: true });
}
