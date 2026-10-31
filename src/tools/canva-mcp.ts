// Client for Canva's hosted MCP server (design editing lives there; the Connect REST API cannot edit existing designs).
// Auth reuses the account's Canva OAuth token. Every request goes through the same host allowlist as api().
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { checkHost } from "../api.js";
import { accessToken, invalidate } from "../providers.js";
import { getAccount } from "../store.js";

export const CANVA_MCP_URL = process.env.CANVA_MCP_URL ?? "https://api.canva.com/connect/v1/mcp";
const IDLE_MS = 5 * 60_000;

interface Conn {
  client: Client;
  timer?: NodeJS.Timeout;
}
const conns = new Map<string, Promise<Conn>>();

function drop(label: string) {
  const p = conns.get(label);
  conns.delete(label);
  p?.then((c) => {
    clearTimeout(c.timer);
    c.client.close().catch(() => {});
  }).catch(() => {});
}

async function connect(label: string): Promise<Conn> {
  const acc = getAccount(label);
  const url = new URL(CANVA_MCP_URL);
  checkHost("canva", acc, url);
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: async (input, init) => {
      const u = new URL(String(input));
      checkHost("canva", acc, u); // never send the bearer token off-host
      const send = async () => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${await accessToken(label)}`);
        return fetch(u, { ...init, headers, redirect: "error" });
      };
      let r = await send();
      if (r.status === 401) {
        invalidate(label);
        r = await send();
      }
      return r;
    },
  });
  const client = new Client({ name: "multi-account-mcp", version: "0.2.0" });
  await client.connect(transport);
  return { client };
}

/** Run `fn` on a (cached, idle-expiring) MCP session for this account; reconnect once if the session went stale. */
async function withClient<T>(label: string, fn: (c: Client) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let p = conns.get(label);
    if (!p) {
      p = connect(label);
      conns.set(label, p);
      p.catch(() => conns.delete(label));
    }
    try {
      const conn = await p;
      clearTimeout(conn.timer);
      conn.timer = setTimeout(() => drop(label), IDLE_MS).unref();
      return await fn(conn.client);
    } catch (e: any) {
      drop(label);
      const msg = String(e?.message ?? e);
      if (attempt === 0 && /session|404|not connected|closed/i.test(msg)) continue;
      if (/401|403|unauthor|forbidden|invalid_token|insufficient/i.test(msg)) {
        throw new Error(
          `Canva MCP rejected this account's token (${msg.slice(0, 300)}). Editing needs "Canva MCP" enabled on the integration in the Canva developer portal; ` +
            `then reconnect the account in /admin so it is authorized for it.`,
        );
      }
      throw e;
    }
  }
}

export async function listCanvaMcpTools(label: string) {
  return withClient(label, async (c) => (await c.listTools()).tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
}

/** Call a Canva MCP tool and return its parsed result (JSON when the text parses, else the raw text). */
export async function callCanvaMcp(label: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const res: any = await withClient(label, (c) => c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }));
  const text = (res.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
  if (res.isError) throw new Error(`Canva ${name}: ${text || "unknown error"}`);
  if (res.structuredContent) return res.structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
