import type { Provider } from "./store.js";

export const DEFAULT_GITLAB = "https://gitlab.com";
const UA = "multi-account-mcp";

/** Providers that can be connected by pasting an API token in /admin. */
export const TOKEN_META: Record<string, { name: string; hint: string }> = {
  github: { name: "GitHub", hint: "Personal access token (one per org). Classic: repo scope; fine-grained: org as resource owner." },
  gitlab: { name: "GitLab", hint: "Personal/group access token with api scope. Set the base URL for self-hosted instances." },
  cloudflare: { name: "Cloudflare", hint: "API token (My Profile → API Tokens), scoped to the zones/permissions you need." },
  discord: { name: "Discord", hint: "Bot token (Developer Portal → Bot). Invite the bot to your server; user tokens are against Discord's ToS." },
  figma: { name: "Figma", hint: "Personal access token (Settings → Security). Scopes: file content read, comments read/write." },
};

/** Auth header(s) for an upstream request. */
export function authHeaders(provider: Provider, token: string): Record<string, string> {
  if (provider === "discord") return { authorization: `Bot ${token}` };
  if (provider === "figma") return { "x-figma-token": token };
  return { authorization: `Bearer ${token}` };
}

async function getJson(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; json: any; headers: Headers }> {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": UA, ...headers } });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json, headers: r.headers };
}

export function normalizeBaseUrl(raw: string | undefined): string {
  const u = new URL((raw || DEFAULT_GITLAB).trim());
  if (u.protocol !== "https:") throw new Error("GitLab base URL must be https");
  return u.origin + u.pathname.replace(/\/(api\/v4)?\/?$/, "");
}

/** Verify a pasted token against the provider and return who it belongs to. Throws if rejected. */
export async function verifyToken(provider: string, token: string, baseUrl?: string): Promise<{ identity: string; scopes: string }> {
  const h = authHeaders(provider as Provider, token);
  const fail = (what: string, r: { status: number; json: any }) => {
    throw new Error(`${what} rejected the token (${r.status}${r.json?.message ? `: ${typeof r.json.message === "string" ? r.json.message : JSON.stringify(r.json.message)}` : ""})`);
  };
  if (provider === "github") {
    const r = await getJson("https://api.github.com/user", h);
    if (!r.ok) fail("GitHub", r);
    return { identity: r.json.login ?? "", scopes: r.headers.get("x-oauth-scopes") ?? "fine-grained" };
  }
  if (provider === "gitlab") {
    const base = normalizeBaseUrl(baseUrl);
    const r = await getJson(`${base}/api/v4/user`, h);
    if (!r.ok) fail("GitLab", r);
    const s = await getJson(`${base}/api/v4/personal_access_tokens/self`, h); // best effort (PATs only)
    return { identity: `${r.json.username}@${new URL(base).hostname}`, scopes: Array.isArray(s.json?.scopes) ? s.json.scopes.join(" ") : "" };
  }
  if (provider === "cloudflare") {
    const base = "https://api.cloudflare.com/client/v4";
    const v = await getJson(`${base}/user/tokens/verify`, h);
    const accts = await getJson(`${base}/accounts?per_page=5`, h);
    if (!(v.ok && v.json.success) && !(accts.ok && accts.json.success)) fail("Cloudflare", v.ok ? accts : v);
    const names = (accts.json?.result ?? []).map((a: any) => a.name).join(", ");
    return { identity: names || `token ${v.json?.result?.id ?? ""}`.trim(), scopes: v.json?.result?.status ?? "" };
  }
  if (provider === "discord") {
    const r = await getJson("https://discord.com/api/v10/users/@me", h);
    if (!r.ok) fail("Discord", r);
    return { identity: `${r.json.username}${r.json.bot ? " (bot)" : ""}`, scopes: "" };
  }
  if (provider === "figma") {
    const r = await getJson("https://api.figma.com/v1/me", h);
    if (!r.ok) fail("Figma", { status: r.status, json: { message: r.json?.err } });
    return { identity: r.json.email ?? r.json.handle ?? "", scopes: "" };
  }
  throw new Error(`Unsupported token provider ${provider}`);
}
