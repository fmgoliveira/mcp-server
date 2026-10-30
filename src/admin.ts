import { Router } from "express";
import { config } from "./config.js";
import { buildAuthUrl, completeConnect, invalidate, redirectUri } from "./providers.js";
import { ENV_CREDENTIAL, getState, listAccounts, listCredentials, save, PROVIDERS, type Account, type OAuthProvider, type Provider } from "./store.js";
import { normalizeBaseUrl, normalizeSiteUrl, TOKEN_META, verifyToken } from "./tokens.js";
import { passwordOk, recordFail, tooManyFails } from "./auth-provider.js";
import { checkAll, daysLeft } from "./health.js";
import { checkSecondFactor, totpEnabled } from "./security.js";
import { badge, esc, gate, icon, META } from "./ui.js";
import { adminMore } from "./admin-more.js";
import {
  ALL_PROVIDERS, endSession, fail, flash, guard, header, LABEL_PATTERN, LABEL_RE, page, PAT_CREDENTIAL, startPre, startSession, validPre,
} from "./admin-shared.js";

export const admin = Router();

// ---------- sign in / out ----------
const loginPage = (error = "") =>
  gate(
    "Sign in · Multi-account MCP",
    `<img class=gate-mark src=/favicon.svg alt="">
<div class=panel><h1>Sign in</h1><p class=lede>Use the admin password from your server's .env file.</p>
<form method=post action=/admin/login style="margin-top:20px">
${error ? `<p class="notice error" role=alert>${esc(error)}</p>` : ""}
<label class=field-label for=password>Admin password</label>
<input id=password type=password name=password autofocus required autocomplete=current-password>
<div class=form-end><button class="btn btn-primary btn-block">Sign in</button></div></form></div>`,
  );

const codePage = (error = "") =>
  gate(
    "Two-step sign-in · Multi-account MCP",
    `<img class=gate-mark src=/favicon.svg alt="">
<div class=panel><h1>Enter your code</h1><p class=lede>Open your authenticator app and type the 6-digit code, or use a recovery code.</p>
<form method=post action=/admin/login/code style="margin-top:20px">
${error ? `<p class="notice error" role=alert>${esc(error)}</p>` : ""}
<label class=field-label for=code>Authenticator code</label>
<input id=code type=text name=code inputmode=numeric autocomplete=one-time-code autofocus required>
<div class=form-end><button class="btn btn-primary btn-block">Verify</button></div></form></div>`,
  );

admin.get("/admin/login", (_req, res) => res.type("html").send(loginPage()));

admin.post("/admin/login", (req, res) => {
  if (tooManyFails()) return void res.status(429).type("html").send(loginPage("Too many attempts. Try again in a few minutes."));
  if (!passwordOk(String(req.body?.password ?? ""))) {
    recordFail();
    return void res.status(401).type("html").send(loginPage("That password isn't right."));
  }
  if (totpEnabled()) {
    startPre(res);
    return void res.redirect("/admin/login/code");
  }
  startSession(res);
  res.redirect("/admin");
});

admin.get("/admin/login/code", (req, res) => (validPre(req) ? res.type("html").send(codePage()) : res.redirect("/admin/login")));

admin.post("/admin/login/code", (req, res) => {
  if (!validPre(req)) return void res.redirect("/admin/login");
  if (tooManyFails()) return void res.status(429).type("html").send(codePage("Too many attempts. Try again in a few minutes."));
  if (!checkSecondFactor(String(req.body?.code ?? ""))) {
    recordFail();
    return void res.status(401).type("html").send(codePage("That code isn't right."));
  }
  startSession(res);
  res.redirect("/admin");
});

admin.post("/admin/logout", (_req, res) => {
  endSession(res);
  res.redirect("/admin/login");
});

// ---------- accounts ----------
const attention = (accounts: Account[]) => {
  const items: string[] = [];
  for (const a of accounts) {
    const d = daysLeft(a);
    if (a.health && !a.health.ok) items.push(`<a href="/admin/account/${esc(a.label)}">${esc(a.label)}</a> is failing`);
    else if (d !== undefined && d < 0) items.push(`<a href="/admin/account/${esc(a.label)}">${esc(a.label)}</a>'s token has expired`);
    else if (d !== undefined && d <= 14) items.push(`<a href="/admin/account/${esc(a.label)}">${esc(a.label)}</a>'s token expires in ${d} day${d === 1 ? "" : "s"}`);
  }
  return items.length ? `<p class="notice warn" role=status><b>Needs attention:</b> ${items.join(" · ")}</p>` : "";
};

export const tagsFor = (a: Account) => {
  const t: string[] = [];
  if (a.isDefault) t.push(`<span class="tag tag-accent" title="Used when a tool is called without an account">default</span>`);
  if (a.readOnly) t.push(`<span class="tag tag-lock" title="Only read-only tools may use this account">read-only</span>`);
  if (a.group) t.push(`<span class=tag title="Group">${esc(a.group)}</span>`);
  const d = daysLeft(a);
  if (d !== undefined && d <= 14) t.push(`<span class="tag tag-warn">${d < 0 ? "token expired" : `expires in ${d} d`}</span>`);
  return t.join("");
};

export const statusDot = (a: Account) =>
  a.health
    ? `<span class="dot ${a.health.ok ? "ok" : "bad"}" title="${a.health.ok ? "Working" : `Failing: ${esc(a.health.error ?? "")}`} (checked ${esc(a.health.checkedAt.slice(0, 16).replace("T", " "))} UTC)"></span>`
    : `<span class="dot" title="Not tested yet"></span>`;

admin.get("/admin", guard, (req, res) => {
  const accounts = listAccounts();
  const groups = ALL_PROVIDERS.map((p) => ({ p, list: accounts.filter((a) => a.provider === p) })).filter((g) => g.list.length);

  const items = (list: Account[]) =>
    list
      .map((a) => {
        const isPat = a.credentialId === PAT_CREDENTIAL;
        const app = listCredentials(a.provider).find((c) => c.id === (a.credentialId ?? ENV_CREDENTIAL));
        const tag = isPat ? "API token" : (app?.name ?? "app missing");
        const identity = [a.email || "unknown identity", a.baseUrl ? a.baseUrl.replace(/^https:\/\//, "") : ""].filter(Boolean).join(" · ");
        const reconnect = isPat
          ? ""
          : `<form method=post action=/admin/connect><input type=hidden name=label value="${esc(a.label)}"><input type=hidden name=provider value="${a.provider}"><input type=hidden name=credential value="${esc(a.credentialId ?? ENV_CREDENTIAL)}"><button class=btn title="Sign in again to refresh access">${icon.refresh}Reconnect</button></form>`;
        const q = `${a.label} ${a.email} ${META[a.provider].name} ${tag} ${a.group ?? ""}`.toLowerCase();
        return `<li class=item data-q="${esc(q)}">${statusDot(a)}
<div class=main><div class=label-row><a class=label href="/admin/account/${esc(a.label)}">${esc(a.label)}</a>${tagsFor(a)}</div><div class=sub>${esc(identity)}</div></div>
<span class=tag title="Added ${esc(a.addedAt.slice(0, 10))}">${esc(tag)}</span>
<details class=menu><summary class="btn btn-quiet btn-icon" aria-label="Actions for ${esc(a.label)}">${icon.more}</summary>
<div class=menu-pop><a class=btn href="/admin/account/${esc(a.label)}">${icon.edit}Settings</a>
<form method=post action="/admin/account/${esc(a.label)}/test"><button class=btn>${icon.check}Test connection</button></form>${reconnect}
<form method=post action=/admin/remove data-confirm="Remove ${esc(a.label)}? Claude will lose access to it."><input type=hidden name=label value="${esc(a.label)}"><button class="btn btn-danger">${icon.trash}Remove</button></form></div></details>
</li>`;
      })
      .join("");

  const body = groups.length
    ? groups
        .map(
          (g) => `<section class=group><h2 class=group-head>${badge(g.p)}${META[g.p].name}<span class=count>${g.list.length}</span></h2>
<ul class=list>${items(g.list)}</ul></section>`,
        )
        .join("") + `<p class=empty id=no-match hidden>No account matches that search.</p>`
    : `<div class=empty><h2>No accounts yet</h2><p>Connect an account and Claude can use it by its label.</p><a class="btn btn-primary" href=/admin/add>${icon.plus}Add account</a></div>`;

  const n = accounts.length;
  const lede = n
    ? `${n} account${n === 1 ? "" : "s"} across ${groups.length} service${groups.length === 1 ? "" : "s"}. Claude picks an account by its label.`
    : "Everything Claude can reach through this server.";
  const actions = n
    ? `${n > 5 ? `<input class=search id=filter type=text placeholder="Search accounts" aria-label="Search accounts">` : ""}<span class=grow></span><form method=post action=/admin/test-all><button class=btn title="Check that every account still works">${icon.check}Test all</button></form><a class="btn btn-primary" href=/admin/add>${icon.plus}Add account</a>`
    : "";
  page(res, "accounts", "Accounts", flash(req) + attention(accounts) + header("Accounts", lede, actions) + body);
});

admin.post("/admin/test-all", guard, async (_req, res) => {
  await checkAll();
  res.redirect("/admin?msg=tested-all");
});

// ---------- add account ----------
admin.get("/admin/add", guard, (req, res) => {
  const configured = (p: OAuthProvider) => listCredentials(p).length > 0;
  const want = String(req.query.service ?? "");
  const firstOAuth = PROVIDERS.find(configured) ?? PROVIDERS[0];
  const selected = PROVIDERS.includes(want as OAuthProvider) ? want : want in TOKEN_META ? `${want}-token` : firstOAuth;

  const tile = (p: Provider, kind: "oauth" | "token", blurb: string, name: string) => {
    const checked = (kind === "oauth" && selected === p) || (kind === "token" && selected === `${p}-token`);
    return `<label class=tile><input type=radio name=provider value="${p}" data-kind=${kind} data-name="${esc(name)}"${checked ? " checked" : ""} required><span>${badge(p, true)}<span><b>${esc(name)}</b><small>${esc(blurb)}</small></span></span></label>`;
  };
  const oauthTiles = PROVIDERS.map((p) => tile(p, "oauth", configured(p) ? META[p].blurb : "Needs an OAuth app", META[p].name)).join("");
  const tokenTiles = Object.keys(TOKEN_META)
    .map((k) => tile(k as Provider, "token", k === "github" ? "Personal access token" : META[k as Provider].blurb, k === "github" ? "GitHub token" : TOKEN_META[k].name))
    .join("");

  const credOptions = listCredentials()
    .map((c) => `<option value="${esc(c.id)}" data-provider="${c.provider}">${esc(c.name)}</option>`)
    .join("");
  const hints = Object.entries(TOKEN_META).map(([k, m]) => `<p class=hint data-hint=${k} hidden>${esc(m.hint)}</p>`).join("");

  const body = `${header("Add account", "Pick a service, give the account a short label, and connect it.")}
<form class=panel id=add-form method=post action=/admin/connect autocomplete=off>
<fieldset><legend class=step-title>Sign in with the service</legend><div class=tiles>${oauthTiles}</div></fieldset>
<fieldset><legend class=step-title>Or paste an API token</legend><div class=tiles>${tokenTiles}</div></fieldset>

<div class=callout data-show=noapp hidden>No OAuth app is set up for <b id=noapp-name></b> yet. <a id=noapp-link href=/admin/apps>Add one</a>, then come back here.</div>

<div style="margin-top:24px">
<div class=form-row>
<div class=field><label class=field-label for=label>Label</label>
<input id=label class=mono type=text name=label placeholder="work" pattern="${LABEL_PATTERN}" required>
<p class=hint>Letters, numbers, - and _ (up to 32). Claude uses this to pick the account; reusing a label replaces that account.</p></div>
<div class=field data-show=oauth><label class=field-label for=credential>OAuth app</label>
<select id=credential name=credential>${credOptions}</select>
<p class=hint>Which of your registered apps signs this account in. Use a private window to choose the right identity.</p></div>
<div class=field data-show=token hidden><label class=field-label for=token>Token</label>
<input id=token type=password name=token autocomplete=new-password disabled required>
${hints}</div>
</div>
<div class=form-row style="margin-top:16px">
<div class=field data-show=atlassian hidden><label class=field-label for=username>Email address</label>
<input id=username type=text name=username placeholder="you@example.com" disabled>
<p class=hint>The Atlassian account the API token belongs to.</p></div>
<div class=field data-show=baseurl hidden><label class=field-label for=baseUrl id=baseurl-label>Base URL</label>
<input id=baseUrl type=text name=baseUrl disabled>
<p class=hint id=baseurl-hint></p></div>
</div>
</div>

<div class=form-end><button class="btn btn-primary" id=add-submit>Connect account</button>
<span class=hint style="margin:0">Tokens are verified against the service and stored encrypted.</span></div>
</form>`;
  page(res, "accounts", "Add account", flash(req) + body);
});

admin.post("/admin/connect", guard, (req, res) => {
  const provider = req.body?.provider as OAuthProvider;
  const label = String(req.body?.label ?? "");
  if (!PROVIDERS.includes(provider) || !LABEL_RE.test(label)) {
    return void fail(res, 400, "Check the form", "Pick a service and a label (letters, numbers, - and _, up to 32 characters).", { href: "/admin/add", text: "Back" });
  }
  const credId = String(req.body?.credential ?? "");
  const cred = listCredentials(provider).find((c) => c.id === (credId || undefined)) ?? listCredentials(provider)[0];
  if (!cred || (credId && cred.id !== credId)) {
    return void fail(res, 400, "No OAuth app", `There is no ${META[provider].name} OAuth app yet. Add one first.`, { href: `/admin/apps?service=${provider}`, text: "Add an OAuth app" });
  }
  res.redirect(buildAuthUrl(provider, label, cred.id));
});

admin.post("/admin/token", guard, async (req, res) => {
  const provider = String(req.body?.provider ?? "");
  const label = String(req.body?.label ?? "");
  const token = String(req.body?.token ?? "").trim();
  const username = String(req.body?.username ?? "").trim();
  if (!(provider in TOKEN_META) || !LABEL_RE.test(label) || !token) {
    return void fail(res, 400, "Check the form", "Service, label and token are all required.", { href: "/admin/add", text: "Back" });
  }
  try {
    const baseUrl = provider === "gitlab" ? normalizeBaseUrl(String(req.body?.baseUrl ?? "")) : provider === "atlassian" ? normalizeSiteUrl(String(req.body?.baseUrl ?? "")) : undefined;
    const { identity, scopes, expiresAt } = await verifyToken(provider, token, baseUrl, username);
    const prev = getState().accounts[label];
    getState().accounts[label] = {
      label,
      provider: provider as Provider,
      email: identity,
      token,
      scopes,
      addedAt: new Date().toISOString(),
      credentialId: PAT_CREDENTIAL,
      ...(baseUrl ? { baseUrl } : {}),
      ...(provider === "atlassian" ? { username } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      health: { ok: true, checkedAt: new Date().toISOString() },
      ...(prev ? { readOnly: prev.readOnly, group: prev.group, isDefault: prev.isDefault } : {}),
    };
    invalidate(label);
    save();
    res.redirect("/admin?msg=token-added");
  } catch (e: any) {
    fail(res, 400, "Couldn't add the token", String(e.message ?? e), { href: "/admin/add", text: "Back" });
  }
});

admin.post("/admin/remove", guard, (req, res) => {
  const label = String(req.body?.label ?? "");
  delete getState().accounts[label];
  invalidate(label);
  save();
  res.redirect("/admin?msg=removed");
});

// ---------- OAuth apps ----------
admin.get("/admin/apps", guard, (req, res) => {
  const creds = listCredentials();
  const want = String(req.query.service ?? "");
  const preset = PROVIDERS.includes(want as OAuthProvider) ? want : PROVIDERS[0];

  const rows = creds
    .map((c) => {
      const used = listAccounts(c.provider).filter((a) => (a.credentialId ?? ENV_CREDENTIAL) === c.id).length;
      const action =
        c.id === ENV_CREDENTIAL
          ? `<span class=tag>from .env</span>`
          : `<form method=post action=/admin/credentials/remove data-confirm="Remove the OAuth app ${esc(c.name)}?"><input type=hidden name=id value="${esc(c.id)}"><button class="btn btn-danger" ${used ? 'disabled title="In use by connected accounts"' : ""}>${icon.trash}Remove</button></form>`;
      return `<li class=item>${badge(c.provider, true)}<div class=main><div class=label>${esc(c.name)}</div>
<div class=sub>${META[c.provider].name} · client ${esc(c.clientId.slice(0, 18))}${c.clientId.length > 18 ? "…" : ""} · ${used} account${used === 1 ? "" : "s"}</div></div>${action}</li>`;
    })
    .join("");

  const options = PROVIDERS.map((p) => `<option value="${p}"${p === preset ? " selected" : ""}>${META[p].name}</option>`).join("");
  const urls = PROVIDERS.map(
    (p) => `<div class=url-row><span class=name>${META[p].name}</span><code>${esc(redirectUri(p))}</code><button type=button class="btn btn-quiet" data-copy="${esc(redirectUri(p))}">${icon.copy}<span data-copy-label>Copy</span></button></div>`,
  ).join("");

  const body = `<p class=crumb><a href=/admin/settings>Settings</a> / OAuth apps</p>
${header("OAuth apps", "The client IDs this server uses to sign in to Google, Microsoft, Canva and GitHub. Secrets are stored encrypted.")}
${rows ? `<ul class=list>${rows}</ul>` : `<div class=empty><h2>No OAuth apps yet</h2><p>Create an app with the provider, then save its client ID and secret below.</p></div>`}

<details class=panel style="margin-top:16px"${rows && !req.query.service ? "" : " open"}><summary>Add an OAuth app</summary>
<form method=post action=/admin/credentials autocomplete=off>
<div class=form-row>
<div class=field><label class=field-label for=cp>Service</label><select id=cp name=provider required>${options}</select></div>
<div class=field><label class=field-label for=cn>Name</label><input id=cn type=text name=name placeholder="canva-personal" maxlength=40 required>
<p class=hint>Reusing a name replaces that app.</p></div>
<div class=field><label class=field-label for=ci>Client ID</label><input id=ci class=mono type=text name=clientId required></div>
<div class=field><label class=field-label for=cs>Client secret</label><input id=cs type=password name=clientSecret autocomplete=new-password required></div>
</div>
<div class=form-end><button class="btn btn-primary">Save OAuth app</button></div>
</form></details>

<details class=panel><summary>Redirect URLs to register with each provider</summary>
${urls}</details>`;
  page(res, "settings", "OAuth apps", flash(req) + body);
});

admin.post("/admin/credentials", guard, (req, res) => {
  const provider = req.body?.provider as OAuthProvider;
  const name = String(req.body?.name ?? "").trim().slice(0, 40);
  const clientId = String(req.body?.clientId ?? "").trim();
  const clientSecret = String(req.body?.clientSecret ?? "").trim();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!PROVIDERS.includes(provider) || !slug || !clientId || !clientSecret) {
    return void fail(res, 400, "Check the form", "Service, name, client ID and client secret are all required.", { href: "/admin/apps", text: "Back" });
  }
  const id = `${provider}-${slug}`;
  if (id === ENV_CREDENTIAL) return void fail(res, 400, "Reserved name", "Pick a different name for this app.", { href: "/admin/apps", text: "Back" });
  const prev = getState().credentials[id];
  getState().credentials[id] = { id, provider, name, clientId, clientSecret, addedAt: prev?.addedAt ?? new Date().toISOString() };
  save();
  res.redirect(`/admin/add?service=${provider}&msg=app-saved`);
});

admin.post("/admin/credentials/remove", guard, (req, res) => {
  const id = String(req.body?.id ?? "");
  if (listAccounts().some((a) => a.credentialId === id)) {
    return void fail(res, 409, "App is in use", "Connected accounts still use this OAuth app. Remove them, or reconnect them with another app, first.", { href: "/admin/apps", text: "Back to OAuth apps" });
  }
  delete getState().credentials[id];
  save();
  res.redirect("/admin/apps?msg=app-removed");
});

// ---------- provider OAuth callbacks ----------
for (const provider of PROVIDERS) {
  admin.get(`/oauth/${provider}/callback`, async (req, res) => {
    try {
      if (req.query.error) throw new Error(String(req.query.error_description ?? req.query.error));
      const a = await completeConnect(provider, String(req.query.code), String(req.query.state));
      res.type("html").send(
        gate(
          "Connected · Multi-account MCP",
          `<img class=gate-mark src=/favicon.svg alt="">
<div class=panel><h1>Account connected</h1>
<div class=result>${badge(provider, true)}<div><div class=label>${esc(a.label)}</div><div class=sub>${esc(a.email)}</div></div></div>
<a class="btn btn-primary btn-block" href=/admin>Back to accounts</a></div>`,
        ),
      );
    } catch (e: any) {
      fail(res, 400, "Couldn't connect the account", String(e.message ?? e), { href: "/admin/add", text: "Try again" });
    }
  });
}

admin.use(adminMore);
void config;
