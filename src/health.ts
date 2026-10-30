// Connection tests: one cheap "who am I" call per account, recorded on the account so the admin UI can show status.
import { api } from "./api.js";
import { getAccount, listAccounts, save, type Account } from "./store.js";
import { DEFAULT_GITLAB } from "./tokens.js";

async function probe(a: Account): Promise<void> {
  const l = a.label;
  switch (a.provider) {
    case "google": await api(l, "google", "https://openidconnect.googleapis.com/v1/userinfo"); return;
    case "microsoft": await api(l, "microsoft", "https://graph.microsoft.com/v1.0/me"); return;
    case "github": await api(l, "github", "https://api.github.com/user"); return;
    case "canva": await api(l, "canva", "https://api.canva.com/rest/v1/users/me/profile"); return;
    case "gitlab": await api(l, "gitlab", `${a.baseUrl ?? DEFAULT_GITLAB}/api/v4/user`); return;
    case "cloudflare":
      try {
        await api(l, "cloudflare", "https://api.cloudflare.com/client/v4/user/tokens/verify");
      } catch {
        await api(l, "cloudflare", "https://api.cloudflare.com/client/v4/accounts", { query: { per_page: 1 } }); // account-owned tokens
      }
      return;
    case "discord": await api(l, "discord", "https://discord.com/api/v10/users/@me"); return;
    case "figma": await api(l, "figma", "https://api.figma.com/v1/me"); return;
    case "slack": {
      const r = await api(l, "slack", "https://slack.com/api/auth.test");
      if (r?.ok === false) throw new Error(`Slack: ${r.error}`);
      return;
    }
    case "notion": await api(l, "notion", "https://api.notion.com/v1/users/me"); return;
    case "linear": {
      const r = await api(l, "linear", "https://api.linear.app/graphql", { method: "POST", body: { query: "{ viewer { id } }" } });
      if (r?.errors?.length) throw new Error(`Linear: ${r.errors[0].message}`);
      return;
    }
    case "atlassian": await api(l, "atlassian", `${a.baseUrl}/rest/api/3/myself`); return;
  }
}

export async function checkAccount(label: string): Promise<NonNullable<Account["health"]>> {
  const acc = getAccount(label);
  let health: NonNullable<Account["health"]>;
  try {
    await probe(acc);
    health = { ok: true, checkedAt: new Date().toISOString() };
  } catch (e: any) {
    health = { ok: false, checkedAt: new Date().toISOString(), error: String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 240) };
  }
  acc.health = health;
  save();
  return health;
}

export async function checkAll(): Promise<void> {
  for (const a of listAccounts()) {
    try {
      await checkAccount(a.label);
    } catch {
      /* account removed while checking */
    }
  }
}

/** Run the checks a little after startup and then every `hours`. 0 turns it off. */
export function startHealthChecks(hours: number): void {
  if (!(hours > 0)) return;
  setTimeout(() => void checkAll(), 30_000).unref();
  setInterval(() => void checkAll(), hours * 3600_000).unref();
}

export const DAY = 86_400_000;
/** Days until a pasted token expires, or undefined when unknown. Negative = already expired. */
export function daysLeft(a: Account, now = Date.now()): number | undefined {
  return a.expiresAt ? Math.floor((Date.parse(a.expiresAt) - now) / DAY) : undefined;
}
