import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";
import { Account, getAccount, getState, OAuthProvider, save } from "./store.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GITHUB_AUTH = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const CANVA_AUTH = "https://www.canva.com/api/oauth/authorize";
const CANVA_TOKEN = "https://api.canva.com/rest/v1/oauth/token";

// Canva requires PKCE (S256) and HTTP Basic client auth on the token endpoint
const canvaBasic = () => ({
  authorization: `Basic ${Buffer.from(`${config.canva.clientId}:${config.canva.clientSecret}`).toString("base64")}`,
});

export const redirectUri = (p: OAuthProvider) => `${config.publicUrl}/oauth/${p}/callback`;

// pending connect flows: state -> {provider,label}
const pending = new Map<string, { provider: OAuthProvider; label: string; verifier: string; expires: number }>();

export function buildAuthUrl(provider: OAuthProvider, label: string): string {
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(48).toString("base64url");
  pending.set(state, { provider, label, verifier, expires: Date.now() + 10 * 60_000 });
  const p = new URLSearchParams();
  if (provider === "github") {
    p.set("client_id", config.github.clientId);
    p.set("redirect_uri", redirectUri("github"));
    if (config.github.scopes.length) p.set("scope", config.github.scopes.join(" ")); // OAuth App only
    p.set("prompt", "select_account");
    p.set("state", state);
    return `${GITHUB_AUTH}?${p}`;
  }
  if (provider === "canva") {
    p.set("client_id", config.canva.clientId);
    p.set("redirect_uri", redirectUri("canva"));
    p.set("response_type", "code");
    p.set("scope", config.canva.scopes.join(" "));
    p.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    p.set("code_challenge_method", "s256");
    p.set("state", state);
    return `${CANVA_AUTH}?${p}`;
  }
  if (provider === "google") {
    p.set("client_id", config.google.clientId);
    p.set("redirect_uri", redirectUri("google"));
    p.set("response_type", "code");
    p.set("scope", config.google.scopes.join(" "));
    p.set("access_type", "offline");
    p.set("prompt", "consent select_account");
    p.set("state", state);
    return `${GOOGLE_AUTH}?${p}`;
  }
  p.set("client_id", config.microsoft.clientId);
  p.set("redirect_uri", redirectUri("microsoft"));
  p.set("response_type", "code");
  p.set("scope", config.microsoft.scopes.join(" "));
  p.set("prompt", "select_account");
  p.set("state", state);
  return `${MS_AUTH}?${p}`;
}

async function tokenRequest(url: string, body: Record<string, string>, extraHeaders: Record<string, string> = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...extraHeaders },
    body: new URLSearchParams(body),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Token endpoint error ${r.status}: ${JSON.stringify(j)}`); // GitHub reports errors with HTTP 200
  return j as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string };
}

export async function completeConnect(provider: OAuthProvider, code: string, state: string): Promise<Account> {
  const ctx = pending.get(state);
  pending.delete(state);
  if (!ctx || ctx.provider !== provider || ctx.expires < Date.now()) throw new Error("Invalid or expired state");
  const cfg = config[provider];
  const tok =
    provider === "canva"
      ? await tokenRequest(
          CANVA_TOKEN,
          { grant_type: "authorization_code", code, code_verifier: ctx.verifier, redirect_uri: redirectUri("canva") },
          canvaBasic(),
        )
      : await tokenRequest(provider === "google" ? GOOGLE_TOKEN : provider === "github" ? GITHUB_TOKEN : MS_TOKEN, {
          grant_type: "authorization_code",
          code,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          redirect_uri: redirectUri(provider),
        });
  // GitHub OAuth Apps issue a single non-expiring token; every other flow must return a refresh token
  if (!tok.refresh_token && provider !== "github") throw new Error("No refresh token returned (revoke the app's access in your account and retry)");
  let email = "";
  if (provider === "google") {
    const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    email = ((await r.json()) as any).email ?? "";
  } else if (provider === "github") {
    const r = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "multi-account-mcp" },
    });
    const me: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GitHub /user failed (${r.status})`);
    email = me.login ? `${me.login}${me.email ? ` <${me.email}>` : ""}` : "";
  } else if (provider === "canva") {
    const r = await fetch("https://api.canva.com/rest/v1/users/me/profile", {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    email = ((await r.json().catch(() => ({}))) as any).profile?.display_name ?? ""; // Canva exposes no email
  } else {
    const r = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    const me: any = await r.json();
    email = me.mail ?? me.userPrincipalName ?? "";
  }
  const account: Account = {
    label: ctx.label,
    provider,
    email,
    refreshToken: tok.refresh_token,
    token: tok.refresh_token ? undefined : tok.access_token,
    scopes: tok.scope ?? cfg.scopes.join(" "),
    addedAt: new Date().toISOString(),
  };
  getState().accounts[ctx.label] = account;
  save();
  if (tok.expires_in) cache.set(ctx.label, { token: tok.access_token, expires: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60_000 });
  return account;
}

const cache = new Map<string, { token: string; expires: number }>();

export function invalidate(label: string) {
  cache.delete(label);
}

export async function accessToken(label: string): Promise<string> {
  const hit = cache.get(label);
  if (hit && hit.expires > Date.now()) return hit.token;
  const acc = getAccount(label);
  if (!acc.refreshToken && acc.token) return acc.token; // non-expiring token (GitHub OAuth App)
  if (!acc.refreshToken) throw new Error(`Account "${label}" has no refresh token; reconnect it in /admin`);
  const cfg = config[acc.provider];
  const tok =
    acc.provider === "canva"
      ? await tokenRequest(CANVA_TOKEN, { grant_type: "refresh_token", refresh_token: acc.refreshToken }, canvaBasic())
      : await tokenRequest(acc.provider === "google" ? GOOGLE_TOKEN : acc.provider === "github" ? GITHUB_TOKEN : MS_TOKEN, {
          grant_type: "refresh_token",
          refresh_token: acc.refreshToken,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          ...(acc.provider === "microsoft" ? { scope: config.microsoft.scopes.join(" ") } : {}),
        });
  if (tok.refresh_token && tok.refresh_token !== acc.refreshToken) {
    acc.refreshToken = tok.refresh_token; // Microsoft, Canva (single-use) and GitHub App rotate refresh tokens
    save();
  }
  cache.set(label, { token: tok.access_token, expires: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60_000 });
  return tok.access_token;
}
