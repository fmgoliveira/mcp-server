import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { Account, getAccount, getState, Provider, save } from "./store.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export const redirectUri = (p: Provider) => `${config.publicUrl}/oauth/${p}/callback`;

// pending connect flows: state -> {provider,label}
const pending = new Map<string, { provider: Provider; label: string; expires: number }>();

export function buildAuthUrl(provider: Provider, label: string): string {
  const state = randomBytes(16).toString("hex");
  pending.set(state, { provider, label, expires: Date.now() + 10 * 60_000 });
  const p = new URLSearchParams();
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

async function tokenRequest(url: string, body: Record<string, string>) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Token endpoint error ${r.status}: ${JSON.stringify(j)}`);
  return j as { access_token: string; refresh_token?: string; expires_in: number; scope?: string; id_token?: string };
}

export async function completeConnect(provider: Provider, code: string, state: string): Promise<Account> {
  const ctx = pending.get(state);
  pending.delete(state);
  if (!ctx || ctx.provider !== provider || ctx.expires < Date.now()) throw new Error("Invalid or expired state");
  const cfg = provider === "google" ? config.google : config.microsoft;
  const tok = await tokenRequest(provider === "google" ? GOOGLE_TOKEN : MS_TOKEN, {
    grant_type: "authorization_code",
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri(provider),
  });
  if (!tok.refresh_token) throw new Error("No refresh token returned (revoke the app's access in your account and retry)");
  let email = "";
  if (provider === "google") {
    const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    email = ((await r.json()) as any).email ?? "";
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
    scopes: tok.scope ?? cfg.scopes.join(" "),
    addedAt: new Date().toISOString(),
  };
  getState().accounts[ctx.label] = account;
  save();
  cache.set(ctx.label, { token: tok.access_token, expires: Date.now() + tok.expires_in * 1000 - 60_000 });
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
  const cfg = acc.provider === "google" ? config.google : config.microsoft;
  const tok = await tokenRequest(acc.provider === "google" ? GOOGLE_TOKEN : MS_TOKEN, {
    grant_type: "refresh_token",
    refresh_token: acc.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    ...(acc.provider === "microsoft" ? { scope: config.microsoft.scopes.join(" ") } : {}),
  });
  if (tok.refresh_token && tok.refresh_token !== acc.refreshToken) {
    acc.refreshToken = tok.refresh_token; // Microsoft rotates refresh tokens
    save();
  }
  cache.set(label, { token: tok.access_token, expires: Date.now() + tok.expires_in * 1000 - 60_000 });
  return tok.access_token;
}
