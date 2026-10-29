import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { config } from "./config.js";
import { getState, save } from "./store.js";

const ACCESS_TTL = 60 * 60; // seconds
const rand = () => randomBytes(32).toString("base64url");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function passwordOk(input: string): boolean {
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(config.adminPassword).digest();
  return timingSafeEqual(a, b);
}

// crude brute-force limiter shared by authorize + admin
const fails: number[] = [];
export function tooManyFails(): boolean {
  const now = Date.now();
  while (fails.length && fails[0] < now - 15 * 60_000) fails.shift();
  return fails.length >= 10;
}
export function recordFail() {
  fails.push(Date.now());
}

const clientsStore: OAuthRegisteredClientsStore = {
  getClient: (id) => getState().clients[id],
  registerClient: (client) => {
    const full = {
      ...client,
      client_id: rand(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    } as OAuthClientInformationFull;
    getState().clients[full.client_id] = full;
    save();
    return full;
  },
};

function prune() {
  const s = getState();
  const now = Date.now();
  for (const [k, v] of Object.entries(s.codes)) if (v.expires < now) delete s.codes[k];
  for (const [k, v] of Object.entries(s.access)) if (v.expires < now) delete s.access[k];
}

function issue(clientId: string): OAuthTokens {
  const s = getState();
  const access = rand();
  const refresh = rand();
  s.access[access] = { clientId, expires: Date.now() + ACCESS_TTL * 1000 };
  s.refresh[refresh] = { clientId };
  save();
  return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL, refresh_token: refresh };
}

export const provider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(client, params: AuthorizationParams, res: Response) {
    const q = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      state: params.state ?? "",
    });
    res.type("html").send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Authorize</title>
<body style="font-family:system-ui;max-width:420px;margin:15vh auto;padding:0 16px">
<h2>Connect Claude</h2>
<p>Claude (<code>${esc(client.client_name ?? client.client_id)}</code>) is asking for access to your multi-account server.</p>
<form method=post action="/authorize/confirm">
${[...q].map(([k, v]) => `<input type=hidden name="${esc(k)}" value="${esc(v)}">`).join("")}
<input type=password name=password placeholder="Admin password" autofocus required style="width:100%;padding:10px;margin:8px 0">
<button style="padding:10px 16px">Approve</button>
</form></body>`);
  },

  async challengeForAuthorizationCode(_client, code) {
    const c = getState().codes[code];
    if (!c) throw new Error("Invalid authorization code");
    return c.challenge;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const s = getState();
    const c = s.codes[code];
    delete s.codes[code];
    if (!c || c.expires < Date.now() || c.clientId !== client.client_id) throw new Error("Invalid authorization code");
    if (redirectUri && redirectUri !== c.redirectUri) throw new Error("redirect_uri mismatch");
    return issue(client.client_id);
  },

  async exchangeRefreshToken(client, refreshToken) {
    const s = getState();
    const r = s.refresh[refreshToken];
    if (!r || r.clientId !== client.client_id) throw new Error("Invalid refresh token");
    delete s.refresh[refreshToken]; // rotate
    return issue(client.client_id);
  },

  async verifyAccessToken(token): Promise<AuthInfo> {
    prune();
    const a = getState().access[token];
    if (!a) throw new Error("Invalid token");
    return { token, clientId: a.clientId, scopes: [], expiresAt: Math.floor(a.expires / 1000) };
  },

  async revokeToken(_client, req) {
    const s = getState();
    delete s.access[req.token];
    delete s.refresh[req.token];
    save();
  },
};

// POST /authorize/confirm
export async function confirmAuthorize(req: Request, res: Response) {
  const { client_id, redirect_uri, code_challenge, state, password } = req.body ?? {};
  const client = getState().clients[client_id];
  if (!client || !client.redirect_uris?.includes(redirect_uri)) return void res.status(400).send("Invalid client or redirect_uri");
  if (tooManyFails()) return void res.status(429).send("Too many attempts, try again later");
  if (typeof password !== "string" || !passwordOk(password)) {
    recordFail();
    return void res.status(401).send("Wrong password");
  }
  const code = rand();
  getState().codes[code] = { clientId: client_id, challenge: code_challenge, redirectUri: redirect_uri, expires: Date.now() + 5 * 60_000 };
  save();
  const u = new URL(redirect_uri);
  u.searchParams.set("code", code);
  if (state) u.searchParams.set("state", state);
  res.redirect(u.toString());
}
