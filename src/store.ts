import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { decryptWith, encryptWith } from "./crypto.js";

export type OAuthProvider = "google" | "microsoft" | "canva" | "github";
export type TokenProvider = "gitlab" | "cloudflare" | "discord" | "figma" | "slack" | "notion" | "linear" | "atlassian"; // connected with a pasted API token (no OAuth)
export type Provider = OAuthProvider | TokenProvider;
export const PROVIDERS: readonly OAuthProvider[] = ["google", "microsoft", "canva", "github"]; // providers with an OAuth flow
export const TOKEN_PROVIDERS: readonly TokenProvider[] = ["gitlab", "cloudflare", "discord", "figma", "slack", "notion", "linear", "atlassian"];

export interface Account {
  label: string; // user-chosen short name, e.g. "work"
  provider: Provider;
  email: string;
  refreshToken?: string; // rotating refresh token (all providers except a non-expiring GitHub OAuth App token)
  token?: string; // non-expiring access token (GitHub OAuth App only; GitHub App tokens use refreshToken)
  scopes: string;
  addedAt: string;
  baseUrl?: string; // instance URL: self-hosted GitLab (default https://gitlab.com) or an Atlassian site (https://acme.atlassian.net)
  username?: string; // Atlassian: the email address that goes with the API token
  readOnly?: boolean; // only read-only tools may use this account
  group?: string; // optional group name; tools accept it in place of an account label to fan out over the group
  isDefault?: boolean; // used when a tool is called without an account label (one default per provider)
  expiresAt?: string; // ISO date when a pasted token expires, when the service tells us
  health?: { ok: boolean; checkedAt: string; error?: string }; // result of the last connection test
  credentialId?: string; // OAuth app used to connect this account; absent/"env" = the client from .env
}

// OAuth client (app) credentials managed in /admin. The secret lives only inside the encrypted state file.
export interface Credential {
  id: string;
  provider: Provider;
  name: string;
  clientId: string;
  clientSecret: string;
  addedAt: string;
}

export interface ActivityEntry {
  t: number; // epoch ms
  tool: string;
  provider?: string;
  account?: string; // label, group name or "all"
  ok: boolean;
  ms: number;
  error?: string; // first line only, never arguments or tokens
  blocked?: boolean; // refused by policy (read-only account or tool switched off)
  client?: string; // MCP client id (short)
}

export interface Settings {
  disabledTools: string[]; // tool names switched off for every account
  totp?: { secret: string; recovery: string[]; lastStep: number }; // two-step sign-in; recovery = sha256 hashes
  totpPending?: string; // secret generated in Settings, not active until a code is confirmed
}

export interface State {
  accounts: Record<string, Account>; // key: label
  credentials: Record<string, Credential>; // key: id
  clients: Record<string, any>; // MCP OAuth dynamic clients
  codes: Record<string, { clientId: string; challenge: string; redirectUri: string; expires: number }>;
  access: Record<string, { clientId: string; expires: number }>;
  refresh: Record<string, { clientId: string }>;
  settings: Settings;
  activity: ActivityEntry[];
}

const file = join(config.dataDir, "state.enc");

const encrypt = (plain: string) => encryptWith(config.encryptionKey, plain);
const decrypt = (buf: Buffer) => decryptWith(config.encryptionKey, buf);

function empty(): State {
  return { accounts: {}, credentials: {}, clients: {}, codes: {}, access: {}, refresh: {}, settings: { disabledTools: [] }, activity: [] };
}

let state: State = existsSync(file) ? { ...empty(), ...JSON.parse(decrypt(readFileSync(file))) } : empty();
state.settings = { ...empty().settings, ...state.settings };

export function getState(): State {
  return state;
}

export function save(): void {
  const tmp = file + ".tmp";
  writeFileSync(tmp, encrypt(JSON.stringify(state)), { mode: 0o600 });
  renameSync(tmp, file);
}

// Frequent, low-value writes (activity log, last-used timestamps) are batched instead of rewriting the file on every call.
let timer: NodeJS.Timeout | undefined;
export function saveSoon(ms = 2000): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    save();
  }, ms);
  timer.unref();
}

const MAX_ACTIVITY = 500;
export function logActivity(e: ActivityEntry): void {
  state.activity.push(e);
  if (state.activity.length > MAX_ACTIVITY) state.activity.splice(0, state.activity.length - MAX_ACTIVITY);
  saveSoon();
}

/** Replace the whole state (used by backup restore). Keeps MCP clients and tokens so Claude stays connected. */
export function replaceState(next: Partial<State>): void {
  state = {
    ...empty(),
    ...next,
    clients: state.clients,
    codes: {},
    access: state.access,
    refresh: state.refresh,
    activity: state.activity,
  };
  state.settings = { ...empty().settings, ...state.settings };
  save();
}

export function getAccount(label: string): Account {
  const a = state.accounts[label];
  if (!a) {
    const known = Object.keys(state.accounts).join(", ") || "none";
    throw new Error(`Unknown account "${label}". Connected accounts: ${known}`);
  }
  return a;
}

export function listAccounts(provider?: Provider): Account[] {
  return Object.values(state.accounts).filter((a) => !provider || a.provider === provider);
}

export const ENV_CREDENTIAL = "env";

export interface ResolvedCredential {
  id: string;
  provider: Provider;
  name: string;
  clientId: string;
  clientSecret: string;
}

/** All OAuth clients usable for a provider: the one from .env (if set) plus those added in /admin. */
export function listCredentials(provider?: Provider): ResolvedCredential[] {
  const out: ResolvedCredential[] = [];
  for (const p of PROVIDERS) {
    if (provider && p !== provider) continue;
    const env = config[p];
    if (env.clientId && env.clientSecret) {
      out.push({ id: ENV_CREDENTIAL, provider: p, name: "Default (.env)", clientId: env.clientId, clientSecret: env.clientSecret });
    }
    for (const c of Object.values(state.credentials)) if (c.provider === p) out.push(c);
  }
  return out;
}

/** Resolve the OAuth client for a provider; no id = first available (prefers .env). */
export function getCredential(provider: Provider, id?: string): ResolvedCredential {
  const all = listCredentials(provider);
  const hit = id ? all.find((c) => c.id === id) : all[0];
  if (!hit) throw new Error(id ? `Unknown ${provider} OAuth app "${id}"` : `No ${provider} OAuth app configured; add one in /admin`);
  return hit;
}
