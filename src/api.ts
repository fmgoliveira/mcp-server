import { getAccount, Provider } from "./store.js";
import { accessToken, invalidate } from "./providers.js";

const MAX_OUT = 60_000; // characters returned to the model per call

const ALLOWED_HOSTS: Record<Provider, RegExp> = {
  google: /^[a-z0-9-]+\.googleapis\.com$/,
  microsoft: /^graph\.microsoft\.com$/,
};

export interface ApiOpts {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: boolean; // return text instead of JSON
}

export async function api(label: string, provider: Provider, url: string, opts: ApiOpts = {}): Promise<any> {
  const acc = getAccount(label);
  if (acc.provider !== provider) throw new Error(`Account "${label}" is a ${acc.provider} account, not ${provider}`);
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS[provider].test(u.hostname)) {
    throw new Error(`Host ${u.hostname} is not allowed for ${provider} accounts`);
  }
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));

  const send = async () =>
    fetch(u, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers: {
        authorization: `Bearer ${await accessToken(label)}`,
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

  let r = await send();
  if (r.status === 401) {
    invalidate(label);
    r = await send();
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} from ${u.hostname}${u.pathname}: ${text.slice(0, 2000)}`);
  if (opts.raw) return text;
  if (!text) return { ok: true };
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function out(data: unknown) {
  let s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (s.length > MAX_OUT) s = s.slice(0, MAX_OUT) + `\n…[truncated ${s.length - MAX_OUT} chars]`;
  return { content: [{ type: "text" as const, text: s }] };
}
