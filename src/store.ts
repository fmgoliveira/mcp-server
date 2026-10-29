import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export type OAuthProvider = "google" | "microsoft" | "canva" | "github";
export type Provider = OAuthProvider;
export const PROVIDERS: readonly Provider[] = ["google", "microsoft", "canva", "github"];

export interface Account {
  label: string; // user-chosen short name, e.g. "work"
  provider: Provider;
  email: string;
  refreshToken?: string; // rotating refresh token (all providers except a non-expiring GitHub OAuth App token)
  token?: string; // non-expiring access token (GitHub OAuth App only; GitHub App tokens use refreshToken)
  scopes: string;
  addedAt: string;
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

export interface State {
  accounts: Record<string, Account>; // key: label
  credentials: Record<string, Credential>; // key: id
  clients: Record<string, any>; // MCP OAuth dynamic clients
  codes: Record<string, { clientId: string; challenge: string; redirectUri: string; expires: number }>;
  access: Record<string, { clientId: string; expires: number }>;
  refresh: Record<string, { clientId: string }>;
}

const file = join(config.dataDir, "state.enc");

function encrypt(plain: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", config.encryptionKey, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

function decrypt(buf: Buffer): string {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const d = createDecipheriv("aes-256-gcm", config.encryptionKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

function empty(): State {
  return { accounts: {}, credentials: {}, clients: {}, codes: {}, access: {}, refresh: {} };
}

let state: State = existsSync(file) ? { ...empty(), ...JSON.parse(decrypt(readFileSync(file))) } : empty();

export function getState(): State {
  return state;
}

export function save(): void {
  const tmp = file + ".tmp";
  writeFileSync(tmp, encrypt(JSON.stringify(state)), { mode: 0o600 });
  renameSync(tmp, file);
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
