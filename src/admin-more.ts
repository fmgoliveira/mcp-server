// Admin pages beyond the account list: account settings, activity log, tool switches, connected clients, settings.
import { Router } from "express";
import { listClients, revokeClient } from "./auth-provider.js";
import { exportBackup, importBackup } from "./backup.js";
import { checkAccount, daysLeft } from "./health.js";
import { beginTotpSetup, confirmTotpSetup, disableTotp, recoveryLeft, totpEnabled } from "./security.js";
import { getState, listAccounts, save } from "./store.js";
import { TOOL_REGISTRY } from "./tools/common.js";
import { badge, esc, icon, META } from "./ui.js";
import { ago, ALL_PROVIDERS, fail, flash, guard, header, LABEL_PATTERN, LABEL_RE, mcpUrl, page, PAT_CREDENTIAL } from "./admin-shared.js";

export const adminMore = Router();

const bool = (v: unknown) => v === "on" || v === "1" || v === "true";

// ---------- one account ----------
adminMore.get("/admin/account/:label", guard, (req, res) => {
  const a = getState().accounts[String(req.params.label)];
  if (!a) return void fail(res, 404, "Account not found", "It may have been removed.", { href: "/admin", text: "Back to accounts" });
  const isPat = a.credentialId === PAT_CREDENTIAL;
  const d = daysLeft(a);
  const status = a.health
    ? `<span class="dot ${a.health.ok ? "ok" : "bad"}"></span><div><b>${a.health.ok ? "Working" : "Failing"}</b><div class=sub style="white-space:normal">${a.health.ok ? "" : `${esc(a.health.error ?? "")} · `}checked ${esc(ago(Date.parse(a.health.checkedAt)))}</div></div>`
    : `<span class=dot></span><div><b>Not tested yet</b><div class=sub>Run a test to check that the account still works.</div></div>`;
  const expiry = a.expiresAt ? `<p class=hint style="margin-top:12px">Token ${d! < 0 ? "expired" : "expires"} on ${esc(a.expiresAt.slice(0, 10))}${d! >= 0 ? ` (${d} day${d === 1 ? "" : "s"} left)` : ""}. Add the label again with a new token to renew it.</p>` : "";

  const body = `${flash(req)}<p class=crumb><a href=/admin>Accounts</a> / ${esc(a.label)}</p>
<div class=page-head><div class=title-row>${badge(a.provider, true)}<div><h1 class=mono-title>${esc(a.label)}</h1><p class=lede>${META[a.provider].name} · ${esc(a.email || "unknown identity")}${a.baseUrl ? ` · ${esc(a.baseUrl.replace(/^https:\/\//, ""))}` : ""}</p></div></div></div>

<div class=panel>
<div class=status-row>${status}
<form method=post action="/admin/account/${esc(a.label)}/test" style="margin-left:auto"><button class=btn>${icon.check}Test connection</button></form></div>${expiry}</div>

<form class=panel method=post action="/admin/account/${esc(a.label)}">
<div class=field><label class=field-label for=group>Group</label>
<input id=group class=mono type=text name=group value="${esc(a.group ?? "")}" placeholder="work" pattern="${LABEL_PATTERN}">
<p class=hint>Tools that search several accounts also accept a group name, so "work" can cover all your work accounts at once.</p></div>
<label class=check><input type=checkbox name=readOnly${a.readOnly ? " checked" : ""}><span><b>Read-only</b><small>Claude can read this account but not send, edit or delete anything in it.</small></span></label>
<label class=check><input type=checkbox name=isDefault${a.isDefault ? " checked" : ""}><span><b>Default for ${esc(META[a.provider].name)}</b><small>Used when Claude doesn't say which ${esc(META[a.provider].name)} account to use.</small></span></label>
<div class=form-end><button class="btn btn-primary">Save changes</button></div>
</form>`;
  page(res, "accounts", a.label, body);
});

adminMore.post("/admin/account/:label", guard, (req, res) => {
  const label = String(req.params.label);
  const a = getState().accounts[label];
  if (!a) return void fail(res, 404, "Account not found", "It may have been removed.");
  const group = String(req.body?.group ?? "").trim();
  if (group && !LABEL_RE.test(group)) return void fail(res, 400, "Check the group name", "Use letters, numbers, - and _ (up to 32 characters).", { href: `/admin/account/${label}`, text: "Back" });
  if (group && getState().accounts[group]) return void fail(res, 400, "Group name taken", `"${group}" is already an account label, so it can't also be a group name.`, { href: `/admin/account/${label}`, text: "Back" });
  a.group = group || undefined;
  a.readOnly = bool(req.body?.readOnly) || undefined;
  a.isDefault = bool(req.body?.isDefault) || undefined;
  if (a.isDefault) for (const o of listAccounts(a.provider)) if (o.label !== label) o.isDefault = undefined;
  save();
  res.redirect(`/admin/account/${label}?msg=saved`);
});

adminMore.post("/admin/account/:label/test", guard, async (req, res) => {
  const label = String(req.params.label);
  if (!getState().accounts[label]) return void fail(res, 404, "Account not found", "It may have been removed.");
  await checkAccount(label);
  res.redirect(`/admin/account/${label}?msg=tested`);
});

// ---------- activity ----------
adminMore.get("/admin/activity", guard, (req, res) => {
  const f = ["failed", "blocked"].includes(String(req.query.show)) ? String(req.query.show) : "all";
  const all = [...getState().activity].reverse();
  const rows = all.filter((e) => (f === "failed" ? !e.ok && !e.blocked : f === "blocked" ? e.blocked : true)).slice(0, 200);
  const clients = Object.values(getState().clients) as any[];
  const manyClients = new Set(all.map((e) => e.client).filter(Boolean)).size > 1;
  const count = (key: string) => (key === "failed" ? all.filter((e) => !e.ok && !e.blocked).length : key === "blocked" ? all.filter((e) => e.blocked).length : all.length);
  const tab = (key: string, text: string) => `<a class=tab href="/admin/activity${key === "all" ? "" : `?show=${key}`}"${f === key ? " aria-current=page" : ""}>${text}<span class=n>${count(key)}</span></a>`;
  const list = rows
    .map((e) => {
      const who = manyClients && e.client ? clients.find((c) => String(c.client_id).startsWith(e.client!))?.client_name : undefined;
      const result = e.blocked ? `<span class="tag tag-warn">blocked</span>` : e.ok ? "" : `<span class="tag tag-bad">failed</span>`;
      return `<li class=item><span class="dot ${e.ok ? "ok" : e.blocked ? "warn" : "bad"}"></span>
<div class=main><div class=label-row><span class=label>${esc(e.tool)}</span>${result}</div>
<div class=sub style="white-space:normal">${[e.account ? esc(e.account) : "", e.error ? esc(e.error) : "", who ? esc(String(who)) : ""].filter(Boolean).join(" · ") || "&nbsp;"}</div></div>
<span class=when title="${esc(new Date(e.t).toISOString())}">${esc(ago(e.t))}<small>${e.ms} ms</small></span></li>`;
    })
    .join("");
  const clear = all.length ? `<form method=post action=/admin/activity/clear data-confirm="Clear the whole activity log?"><button class="btn btn-quiet">${icon.trash}Clear log</button></form>` : "";
  const body = `${flash(req)}${header("Activity", "The last 500 tool calls: what ran, on which account, and whether it worked. Arguments and results are never recorded.")}
<nav class=tabs aria-label="Filter activity">${tab("all", "All")}${tab("failed", "Failed")}${tab("blocked", "Blocked")}<span class=grow></span>${clear}</nav>
${list ? `<ul class=list>${list}</ul>` : `<div class=empty><h2>${all.length ? "Nothing matches" : "No activity yet"}</h2><p>${all.length ? "Try another filter." : "Calls appear here as soon as Claude uses a tool."}</p></div>`}`;
  page(res, "activity", "Activity", body);
});

adminMore.post("/admin/activity/clear", guard, (_req, res) => {
  getState().activity = [];
  save();
  res.redirect("/admin/activity?msg=cleared");
});

// ---------- tool switches ----------
adminMore.get("/admin/tools", guard, (req, res) => {
  const off = new Set(getState().settings.disabledTools);
  const groups: [string, string][] = [...ALL_PROVIDERS.map((p) => [p, META[p].name] as [string, string]), ["general", "General"]];
  const sections = groups
    .map(([key, name]) => {
      const tools = [...TOOL_REGISTRY.values()].filter((t) => (key === "general" ? !t.provider : t.provider === key)).sort((a, b) => a.name.localeCompare(b.name));
      if (!tools.length) return "";
      const on = tools.filter((t) => !off.has(t.name)).length;
      const rows = tools
        .map((t) => `<label class=tool-row><input type=checkbox name=on value="${esc(t.name)}"${off.has(t.name) ? "" : " checked"}><span class=tname>${esc(t.name)}</span><span class=tdesc>${esc(t.description.split(/(?<=\.)\s/)[0].slice(0, 140))}</span><span class="tag${t.readOnly ? "" : " tag-lock"}">${t.readOnly ? "read" : "write"}</span></label>`)
        .join("");
      return `<details class=panel><summary>${key === "general" ? "" : badge(key as any)}<b>${esc(name)}</b><span class=count>${on} of ${tools.length} on</span></summary>
<form method=post action=/admin/tools><input type=hidden name=group value="${key}"><div class=tool-list>${rows}</div>
<div class=form-end><button class="btn btn-primary" name=preset value=save>Save</button><button class=btn name=preset value=reads>Reads only</button><button class=btn name=preset value=all>Switch all on</button></div></form></details>`;
    })
    .join("");
  const totalOff = off.size;
  const body = `${flash(req)}${header("Tools", `Switch off any tool you don't want Claude to have. Changes apply to the next request.${totalOff ? ` ${totalOff} tool${totalOff === 1 ? " is" : "s are"} off.` : ""} To limit a single account instead, make it read-only on its account page.`)}${sections || `<div class=empty><h2>No tools loaded</h2></div>`}`;
  page(res, "tools", "Tools", body);
});

adminMore.post("/admin/tools", guard, (req, res) => {
  const key = String(req.body?.group ?? "");
  const tools = [...TOOL_REGISTRY.values()].filter((t) => (key === "general" ? !t.provider : t.provider === key));
  if (!tools.length) return void fail(res, 400, "Unknown group", "That group of tools doesn't exist.", { href: "/admin/tools", text: "Back" });
  const preset = String(req.body?.preset ?? "save");
  const picked = new Set(([] as string[]).concat(req.body?.on ?? []));
  const enabled = (t: (typeof tools)[number]) => (preset === "all" ? true : preset === "reads" ? t.readOnly : picked.has(t.name));
  const names = new Set(tools.map((t) => t.name));
  const s = getState().settings;
  s.disabledTools = [...s.disabledTools.filter((n) => !names.has(n)), ...tools.filter((t) => !enabled(t)).map((t) => t.name)];
  save();
  res.redirect("/admin/tools?msg=saved");
});

// ---------- connected clients ----------
adminMore.get("/admin/clients", guard, (req, res) => {
  const clients = listClients();
  const idle = clients.filter((c) => c.sessions === 0);
  const rows = clients
    .map(
      (c) => `<li class=item><div class=main><div class=label-row><b>${esc(c.name)}</b><span class=tag title="Client id">${esc(c.id.slice(0, 8))}</span>${c.sessions === 0 ? `<span class="tag tag-warn" title="No refresh token: it has to be approved again before it can connect">no session</span>` : ""}</div>
<div class=sub style="white-space:normal">${c.redirectHosts.map(esc).join(", ") || "no redirect"} · ${c.lastUsed ? `last used ${esc(ago(c.lastUsed))}` : "not used yet"} · approved ${c.issuedAt ? esc(ago(c.issuedAt)) : "earlier"}${c.sessions ? ` · ${c.sessions} active session${c.sessions === 1 ? "" : "s"}` : ""}</div></div>
<form method=post action=/admin/clients/revoke data-confirm="Revoke ${esc(c.name)}? It loses access immediately."><input type=hidden name=id value="${esc(c.id)}"><button class="btn btn-danger">${icon.trash}Revoke</button></form></li>`,
    )
    .join("");
  const cleanup = idle.length
    ? `<span class=grow></span><form method=post action=/admin/clients/cleanup data-confirm="Remove ${idle.length} client${idle.length === 1 ? "" : "s"} without an active session?"><button class=btn>${icon.trash}Remove ${idle.length} without a session</button></form>`
    : "";
  const body = `${flash(req)}${header("Clients", "Apps approved to use this server. Revoking one signs it out at once. Claude adds an entry each time you re-add the connector, so old ones can pile up.", cleanup)}
${rows ? `<ul class=list>${rows}</ul>` : `<div class=empty><h2>No clients yet</h2><p>Add <code>${esc(mcpUrl)}</code> as a custom connector in Claude to see it here.</p></div>`}`;
  page(res, "clients", "Clients", body);
});

adminMore.post("/admin/clients/revoke", guard, (req, res) => {
  revokeClient(String(req.body?.id ?? ""));
  res.redirect("/admin/clients?msg=revoked");
});

adminMore.post("/admin/clients/cleanup", guard, (_req, res) => {
  for (const c of listClients()) if (c.sessions === 0) revokeClient(c.id);
  res.redirect("/admin/clients?msg=cleaned");
});

// ---------- settings: two-step sign-in, backup, key rotation ----------
adminMore.get("/admin/settings", guard, (req, res) => {
  const on = totpEnabled();
  const twoStep = on
    ? `<p>On. You'll be asked for a code from your authenticator app after the password. ${recoveryLeft()} recovery code${recoveryLeft() === 1 ? "" : "s"} left.</p>
<form method=post action=/admin/settings/2fa/disable class=inline-form><input type=text name=code inputmode=numeric placeholder="Code to confirm" aria-label="Authenticator code" required><button class="btn btn-danger">Turn off</button></form>`
    : `<p>Add an authenticator app code to the admin password. It also applies when Claude asks for approval.</p><a class=btn href=/admin/settings/2fa>Set up two-step sign-in</a>`;
  const body = `${flash(req, String(req.query.err ?? "") === "code" ? "That code isn't right." : "")}${header("Settings", "Security, OAuth apps and backups for this server.")}
<section class=panel><h2>Two-step sign-in</h2>${twoStep}</section>
<section class=panel><h2>OAuth apps</h2><p>Client IDs and secrets for Google, Microsoft, Canva and GitHub.</p><a class=btn href=/admin/apps>Manage OAuth apps</a></section>
<section class=panel><h2>Backup</h2>
<p>Download your accounts, OAuth apps and settings as a file protected by a passphrase. It can be restored on any instance, even one with a different encryption key. Claude's connection isn't included.</p>
<form method=post action=/admin/backup/export class=inline-form><input type=password name=passphrase placeholder="Passphrase (8+ characters)" minlength=8 autocomplete=new-password required><button class=btn>${icon.download}Download backup</button></form>
<details class=sub-details><summary>Restore from a backup</summary>
<form method=post action=/admin/backup/import data-confirm="Replace all accounts, OAuth apps and settings with the backup?">
<div class=field><label class=field-label for=bfile>Backup file</label><input id=bfile type=file data-fill=backup accept=".txt,text/plain"></div>
<div class=field><label class=field-label for=backup>Or paste its contents</label><textarea name=backup id=backup rows=4 spellcheck=false required></textarea></div>
<div class=field><label class=field-label for=bpass>Passphrase</label><input id=bpass class=narrow type=password name=passphrase autocomplete=off required></div>
<div class=form-end><button class="btn btn-danger">Replace everything with this backup</button></div></form></details></section>
<section class=panel><h2>Encryption key</h2>
<p>To change <code>ENCRYPTION_KEY</code>, run this on the server, then put the printed key in <code>.env</code> and restart. The old file is kept as a backup next to <code>state.enc</code>.</p>
<div class=cmd><code>docker compose exec mcp node dist/cli/rotate-key.js</code><button type=button class="btn btn-quiet" data-copy="docker compose exec mcp node dist/cli/rotate-key.js">${icon.copy}<span data-copy-label>Copy</span></button></div></section>`;
  page(res, "settings", "Settings", body);
});

const setupPage = (req: any, res: any, error = "") => {
  const t = beginTotpSetup("admin");
  const body = `<p class=crumb><a href=/admin/settings>Settings</a> / Two-step sign-in</p>${flash(req, error)}${header("Set up two-step sign-in", "Scan the code with an authenticator app (1Password, Google Authenticator, Aegis…), then enter the 6-digit code it shows.")}
<div class=panel><div class=qr-row><div class=qr>${t.qrSvg}</div>
<div><p class=hint style="margin-top:0">Can't scan? Enter this key by hand:</p><div class=cmd><code>${esc(t.secret)}</code><button type=button class="btn btn-quiet" data-copy="${esc(t.secret)}">${icon.copy}<span data-copy-label>Copy</span></button></div>
<form method=post action=/admin/settings/2fa/confirm style="margin-top:20px"><label class=field-label for=code>Code from the app</label>
<input id=code type=text name=code inputmode=numeric autocomplete=one-time-code required><div class=form-end><button class="btn btn-primary">Turn on</button></div></form></div></div></div>`;
  page(res, "settings", "Two-step sign-in", body);
};
adminMore.get("/admin/settings/2fa", guard, (req, res) => (totpEnabled() ? res.redirect("/admin/settings") : setupPage(req, res)));

adminMore.post("/admin/settings/2fa/confirm", guard, (req, res) => {
  const codes = confirmTotpSetup(String(req.body?.code ?? ""));
  if (!codes) return void setupPage(req, res, "That code isn't right. Check the time on your phone and try again.");
  const body = `${header("Two-step sign-in is on", "Save these recovery codes somewhere safe. Each works once if you lose your authenticator, and they won't be shown again.")}
<div class=panel><div class=codes>${codes.map((c) => `<code>${esc(c)}</code>`).join("")}</div>
<div class=form-end><button type=button class=btn data-copy="${esc(codes.join("\n"))}">${icon.copy}<span data-copy-label>Copy codes</span></button><a class="btn btn-primary" href=/admin/settings>Done</a></div></div>`;
  page(res, "settings", "Recovery codes", body);
});

adminMore.post("/admin/settings/2fa/disable", guard, (req, res) => {
  if (!disableTotp(String(req.body?.code ?? ""))) return void res.redirect("/admin/settings?err=code");
  res.redirect("/admin/settings?msg=2fa-off");
});

adminMore.post("/admin/backup/export", guard, (req, res) => {
  try {
    const file = exportBackup(String(req.body?.passphrase ?? ""));
    res.setHeader("Content-Disposition", `attachment; filename="mcp-backup-${new Date().toISOString().slice(0, 10)}.txt"`);
    res.type("text/plain").send(file);
  } catch (e: any) {
    fail(res, 400, "Couldn't create the backup", String(e.message ?? e), { href: "/admin/settings", text: "Back to settings" });
  }
});

adminMore.post("/admin/backup/import", guard, (req, res) => {
  try {
    importBackup(String(req.body?.passphrase ?? ""), String(req.body?.backup ?? ""));
    res.redirect("/admin/settings?msg=restored");
  } catch (e: any) {
    fail(res, 400, "Couldn't restore the backup", String(e.message ?? e), { href: "/admin/settings", text: "Back to settings" });
  }
});
