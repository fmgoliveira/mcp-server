import { getAccount, Provider, type Account } from "./store.js";
import { accessToken, invalidate } from "./providers.js";
import { authHeaders, DEFAULT_GITLAB } from "./tokens.js";

const MAX_OUT = 60_000; // characters returned to the model per call

const ALLOWED_HOSTS: Record<Provider, RegExp> = {
  google: /^[a-z0-9-]+\.googleapis\.com$/,
  microsoft: /^graph\.microsoft\.com$/,
  github: /^api\.github\.com$/,
  canva: /^api\.canva\.com$/,
  gitlab: /^$/, // checked against the account's own base URL (see checkHost)
  cloudflare: /^api\.cloudflare\.com$/,
  discord: /^discord\.com$/,
  figma: /^api\.figma\.com$/,
  slack: /^slack\.com$/,
  notion: /^api\.notion\.com$/,
  linear: /^api\.linear\.app$/,
  atlassian: /^$/, // checked against the account's own site URL (see checkHost)
};

export interface ApiOpts {
  method?: string;
  query?: Record<string, string | number | boolean | string[] | undefined>; // arrays repeat the key (`include[]=a&include[]=b`)
  body?: unknown;
  headers?: Record<string, string>;
  raw?: boolean; // return text instead of JSON
  pages?: number; // follow RFC 5988 `Link: rel="next"` up to N pages, concatenating array results (GitHub)
}

function nextLink(r: Response): string | undefined {
  const link = r.headers.get("link");
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return undefined;
}

export function checkHost(provider: Provider, acc: Account, u: URL) {
  const ok =
    u.protocol === "https:" &&
    (provider === "gitlab" || provider === "atlassian"
      ? !!(acc.baseUrl ?? (provider === "gitlab" ? DEFAULT_GITLAB : "")) && u.hostname === new URL(acc.baseUrl ?? DEFAULT_GITLAB).hostname
      : ALLOWED_HOSTS[provider].test(u.hostname));
  if (!ok) throw new Error(`Host ${u.hostname} is not allowed for ${provider} accounts`);
}

function defaultHeaders(provider: Provider): Record<string, string> {
  if (provider === "github") {
    return { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "multi-account-mcp" };
  }
  if (provider === "discord") return { "user-agent": "DiscordBot (https://github.com/multi-account-mcp, 1.0)" };
  return {};
}

export async function api(label: string, provider: Provider, url: string, opts: ApiOpts = {}): Promise<any> {
  const acc = getAccount(label);
  if (acc.provider !== provider) throw new Error(`Account "${label}" is a ${acc.provider} account, not ${provider}`);
  const first = new URL(url);
  checkHost(provider, acc, first);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => first.searchParams.append(k, x));
    else first.searchParams.set(k, String(v));
  }

  const send = async (u: URL) =>
    fetch(u, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers: {
        ...defaultHeaders(provider),
        ...authHeaders(provider, await accessToken(label), acc.username),
        ...(opts.body !== undefined && !(opts.body instanceof Uint8Array) ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      body:
        opts.body === undefined
          ? undefined
          : opts.body instanceof Uint8Array || typeof opts.body === "string"
            ? (opts.body as any)
            : JSON.stringify(opts.body),
    });

  const fetchOnce = async (u: URL) => {
    let r = await send(u);
    if (r.status === 401) {
      invalidate(label);
      r = await send(u);
    }
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} from ${u.hostname}${u.pathname}: ${text.slice(0, 2000)}`);
    return { r, text };
  };

  let { r, text } = await fetchOnce(first);
  if (opts.raw) return text;
  const parse = (t: string) => {
    if (!t) return { ok: true };
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  };
  let result = parse(text);

  // Pagination: only for GET collections that return arrays (or {items|workflow_runs|...: []} are left to callers)
  if (opts.pages && opts.pages > 1 && Array.isArray(result)) {
    for (let i = 1; i < opts.pages; i++) {
      const next = nextLink(r);
      if (!next) break;
      const nu = new URL(next);
      checkHost(provider, acc, nu); // never follow a Link header off-host with the bearer token
      ({ r, text } = await fetchOnce(nu));
      const more = parse(text);
      if (!Array.isArray(more)) break;
      result = result.concat(more);
    }
  }
  return result;
}

export function out(data: unknown) {
  let s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (s.length > MAX_OUT) s = s.slice(0, MAX_OUT) + `\n…[truncated ${s.length - MAX_OUT} chars]`;
  return { content: [{ type: "text" as const, text: s }] };
}
