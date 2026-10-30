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
  slack: { name: "Slack", hint: "Bot token (xoxb-…) from a Slack app, or a user token (xoxp-…) if you want search. Add the channels:read, channels:history, chat:write and users:read scopes." },
  notion: { name: "Notion", hint: "Internal integration secret (notion.so/profile/integrations). Share each page or database with the integration, or Claude can't see it." },
  linear: { name: "Linear", hint: "Personal API key (Settings → Account → Security & access)." },
  atlassian: { name: "Jira and Confluence", hint: "Atlassian Cloud API token (id.atlassian.com → Security → API tokens), with the email it belongs to and your site URL, e.g. https://acme.atlassian.net." },
};

/** Auth header(s) for an upstream request. */
export function authHeaders(provider: Provider, token: string, user?: string): Record<string, string> {
  if (provider === "discord") return { authorization: `Bot ${token}` };
  if (provider === "figma") return { "x-figma-token": token };
  if (provider === "linear") return { authorization: token.startsWith("lin_oauth_") ? `Bearer ${token}` : token };
  if (provider === "atlassian") return { authorization: `Basic ${Buffer.from(`${user ?? ""}:${token}`).toString("base64")}` };
  if (provider === "notion") return { authorization: `Bearer ${token}`, "notion-version": NOTION_VERSION };
  return { authorization: `Bearer ${token}` };
}

export const NOTION_VERSION = "2022-06-28";

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

/** Atlassian sites must be https://<name>.atlassian.net (or a self-managed https host); returns the origin. */
export function normalizeSiteUrl(raw: string | undefined): string {
  if (!raw?.trim()) throw new Error("Atlassian needs your site URL, e.g. https://acme.atlassian.net");
  const u = new URL(raw.trim());
  if (u.protocol !== "https:") throw new Error("The site URL must be https");
  return u.origin;
}

export interface Verified {
  identity: string;
  scopes: string;
  expiresAt?: string;
}

/** Verify a pasted token against the provider and return who it belongs to. Throws if rejected. */
export async function verifyToken(provider: string, token: string, baseUrl?: string, user?: string): Promise<Verified> {
  const h = authHeaders(provider as Provider, token, user);
  const fail = (what: string, r: { status: number; json: any }) => {
    throw new Error(`${what} rejected the token (${r.status}${r.json?.message ? `: ${typeof r.json.message === "string" ? r.json.message : JSON.stringify(r.json.message)}` : ""})`);
  };
  if (provider === "github") {
    const r = await getJson("https://api.github.com/user", h);
    if (!r.ok) fail("GitHub", r);
    const exp = r.headers.get("github-authentication-token-expiration"); // e.g. "2026-12-01 10:00:00 UTC"
    const when = exp ? new Date(exp.replace(" UTC", "Z").replace(" ", "T")) : undefined;
    return { identity: r.json.login ?? "", scopes: r.headers.get("x-oauth-scopes") ?? "fine-grained", expiresAt: when && !isNaN(+when) ? when.toISOString() : undefined };
  }
  if (provider === "gitlab") {
    const base = normalizeBaseUrl(baseUrl);
    const r = await getJson(`${base}/api/v4/user`, h);
    if (!r.ok) fail("GitLab", r);
    const s = await getJson(`${base}/api/v4/personal_access_tokens/self`, h); // best effort (PATs only)
    const exp = s.json?.expires_at ? new Date(`${s.json.expires_at}T23:59:59Z`).toISOString() : undefined;
    return { identity: `${r.json.username}@${new URL(base).hostname}`, scopes: Array.isArray(s.json?.scopes) ? s.json.scopes.join(" ") : "", expiresAt: exp };
  }
  if (provider === "cloudflare") {
    const base = "https://api.cloudflare.com/client/v4";
    const v = await getJson(`${base}/user/tokens/verify`, h);
    const accts = await getJson(`${base}/accounts?per_page=5`, h);
    if (!(v.ok && v.json.success) && !(accts.ok && accts.json.success)) fail("Cloudflare", v.ok ? accts : v);
    const names = (accts.json?.result ?? []).map((a: any) => a.name).join(", ");
    const exp = v.json?.result?.expires_on ? new Date(v.json.result.expires_on).toISOString() : undefined;
    return { identity: names || `token ${v.json?.result?.id ?? ""}`.trim(), scopes: v.json?.result?.status ?? "", expiresAt: exp };
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
  if (provider === "slack") {
    const r = await getJson("https://slack.com/api/auth.test", h);
    if (!r.ok || !r.json.ok) fail("Slack", { status: r.status, json: { message: r.json?.error } });
    return { identity: `${r.json.user}${r.json.team ? ` @ ${r.json.team}` : ""}`, scopes: r.headers.get("x-oauth-scopes") ?? "" };
  }
  if (provider === "notion") {
    const r = await getJson("https://api.notion.com/v1/users/me", h);
    if (!r.ok) fail("Notion", r);
    return { identity: r.json.bot?.workspace_name ?? r.json.name ?? "Notion integration", scopes: "" };
  }
  if (provider === "linear") {
    const r = await fetch("https://api.linear.app/graphql", { method: "POST", headers: { "content-type": "application/json", "user-agent": UA, ...h }, body: JSON.stringify({ query: "{ viewer { name email } }" }) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.data?.viewer) fail("Linear", { status: r.status, json: { message: j.errors?.[0]?.message } });
    return { identity: j.data.viewer.email ?? j.data.viewer.name, scopes: "" };
  }
  if (provider === "atlassian") {
    const base = normalizeSiteUrl(baseUrl);
    if (!user?.trim()) throw new Error("Atlassian needs the email address the token belongs to");
    const r = await getJson(`${base}/rest/api/3/myself`, h);
    if (!r.ok) fail("Atlassian", r);
    return { identity: `${r.json.emailAddress ?? user} @ ${new URL(base).hostname}`, scopes: "" };
  }
  throw new Error(`Unsupported token provider ${provider}`);
}
