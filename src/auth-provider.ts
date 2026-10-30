import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { config } from "./config.js";
import { getState, save, saveSoon } from "./store.js";
import { errorGate, esc, gate } from "./ui.js";
import { checkSecondFactor, totpEnabled } from "./security.js";

const ACCESS_TTL = 60 * 60; // seconds
const rand = () => randomBytes(32).toString("base64url");

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


interface ConsentInfo {
  clientName: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

// Shown to whoever opens the authorization link, before they have proven anything. It must not reveal
// account labels or identities, and the client name is self-reported (dynamic registration), so it is escaped.
function consentPage(i: ConsentInfo, error = ""): string {
  const name = esc(i.clientName.slice(0, 40));
  const hidden = Object.entries({ client_id: i.clientId, redirect_uri: i.redirectUri, code_challenge: i.codeChallenge, state: i.state })
    .map(([k, v]) => `<input type=hidden name="${k}" value="${esc(v)}">`)
    .join("");
  return gate(
    "Authorize · Multi-account MCP",
    `<svg class=diagram viewBox="0 0 320 96" role=img aria-label="${name} connecting to this server">
<circle class=node cx=40 cy=38 r=26 /><path class=glyph d="M29 33a3 3 0 0 1 3-3h16a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H39l-7 5v-5a3 3 0 0 1-3-3z"/>
<path class=cable pathLength=1 d="M68 38C120 38 130 38 172 38S228 38 250 38"/>
<g transform="translate(262 12) scale(.8125)"><rect width=64 height=64 rx=14 fill="#0b3d36"/>
<g fill=none stroke="#7ee2cc" stroke-width=3.5 stroke-linecap=round><path d="M15 17C31 17 31 32 46 32M15 32H46M15 47C31 47 31 32 46 32"/></g>
<g fill="#7ee2cc"><circle cx=15 cy=17 r=4.5 /><circle cx=15 cy=32 r=4.5 /><circle cx=15 cy=47 r=4.5 /></g><circle cx=47 cy=32 r=7.5 fill="#ffb547"/></g>
<text x=40 y=84>${esc(i.clientName.slice(0, 18))}</text><text x=288 y=84>This server</text></svg>
<div class=panel><h1>Allow ${name} to connect?</h1>
<p class=lede>It will be able to use every account you have connected to this server.</p>
<ul class=facts><li><span>Asking app</span><span>${name}</span></li><li><span>Returns to</span><span>${esc(hostOf(i.redirectUri))}</span></li></ul>
<form method=post action="/authorize/confirm" style="margin-top:20px">${hidden}
${error ? `<p class="notice error" role=alert>${esc(error)}</p>` : ""}
<label class=field-label for=password>Admin password</label>
<input id=password type=password name=password autofocus required autocomplete=current-password>
${totpEnabled() ? `<label class=field-label for=code style="margin-top:14px">Authenticator code</label>
<input id=code type=text name=code inputmode=numeric autocomplete=one-time-code placeholder="6-digit code or recovery code" required>` : ""}
<div class=actions><button class="btn btn-primary" name=action value=approve>Approve</button>
<button class=btn name=action value=deny formnovalidate>Deny</button></div></form>
<p class=fine>Only approve if you just started this from Claude.</p></div>`,
  );
}

const clientsStore: OAuthRegisteredClientsStore = {
  getClient: (id) => getState().clients[id],
  registerClient: (client) => {
    // Claude registers afresh every time the connector is (re-)added. For public clients with identical metadata, hand back
    // the existing entry instead of piling up duplicates.
    const uris = JSON.stringify([...(client.redirect_uris ?? [])].map(String).sort());
    const twin = !(client as any).client_secret && Object.values(getState().clients).find((c: any) => !c.client_secret && c.client_name === client.client_name && JSON.stringify([...(c.redirect_uris ?? [])].map(String).sort()) === uris);
    if (twin) return twin as OAuthClientInformationFull;
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
    res.type("html").send(
      consentPage({
        clientName: client.client_name ?? "An app",
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state ?? "",
      }),
    );
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
    const c = getState().clients[a.clientId];
    if (c && Date.now() - (c.last_used ?? 0) > 60_000) {
      c.last_used = Date.now();
      saveSoon();
    }
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
  const { client_id, redirect_uri, code_challenge, state, password, action, code: otp } = req.body ?? {};
  const client = getState().clients[client_id];
  if (!client || !client.redirect_uris?.includes(redirect_uri)) {
    return void res.status(400).type("html").send(errorGate("Can't authorize", "This request doesn't match a registered app. Start the connection again from Claude."));
  }
  const back = (extra: Record<string, string>) => {
    const u = new URL(redirect_uri);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    if (state) u.searchParams.set("state", state);
    return u.toString();
  };
  if (action === "deny") return void res.redirect(back({ error: "access_denied" }));

  const info: ConsentInfo = {
    clientName: client.client_name ?? "An app",
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: String(code_challenge ?? ""),
    state: String(state ?? ""),
  };
  if (tooManyFails()) return void res.status(429).type("html").send(consentPage(info, "Too many attempts. Try again in a few minutes."));
  if (typeof password !== "string" || !passwordOk(password)) {
    recordFail();
    return void res.status(401).type("html").send(consentPage(info, "That password isn't right."));
  }
  if (totpEnabled() && !checkSecondFactor(String(otp ?? ""))) {
    recordFail();
    return void res.status(401).type("html").send(consentPage(info, "That authenticator code isn't right."));
  }
  const code = rand();
  getState().codes[code] = { clientId: client_id, challenge: code_challenge, redirectUri: redirect_uri, expires: Date.now() + 5 * 60_000 };
  save();
  res.redirect(back({ code }));
}

// ---- connected MCP clients (what appears under Clients in the admin UI) ----
export interface ClientInfo {
  id: string;
  name: string;
  issuedAt: number;
  lastUsed?: number;
  redirectHosts: string[];
  sessions: number;
}

export function listClients(): ClientInfo[] {
  const s = getState();
  return Object.values(s.clients)
    .map((c: any) => ({
      id: String(c.client_id),
      name: String(c.client_name ?? "Unnamed app"),
      issuedAt: (c.client_id_issued_at ?? 0) * 1000,
      lastUsed: c.last_used as number | undefined,
      redirectHosts: [...new Set<string>((c.redirect_uris ?? []).map(hostOf))],
      sessions: Object.values(s.refresh).filter((r) => r.clientId === c.client_id).length,
    }))
    .sort((a, b) => (b.lastUsed ?? b.issuedAt) - (a.lastUsed ?? a.issuedAt));
}

/** Forget a client and every token and pending code it holds; it has to be approved again to reconnect. */
export function revokeClient(id: string): boolean {
  const s = getState();
  if (!s.clients[id]) return false;
  delete s.clients[id];
  for (const [k, v] of Object.entries(s.access)) if (v.clientId === id) delete s.access[k];
  for (const [k, v] of Object.entries(s.refresh)) if (v.clientId === id) delete s.refresh[k];
  for (const [k, v] of Object.entries(s.codes)) if (v.clientId === id) delete s.codes[k];
  save();
  return true;
}
