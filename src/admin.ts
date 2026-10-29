import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "./config.js";
import { buildAuthUrl, completeConnect, invalidate, redirectUri } from "./providers.js";
import { ENV_CREDENTIAL, getState, listAccounts, listCredentials, save, PROVIDERS, type OAuthProvider } from "./store.js";
import { passwordOk, recordFail, tooManyFails } from "./auth-provider.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sign = (v: string) => createHmac("sha256", config.encryptionKey).update(v).digest("base64url");

function makeSession(): string {
  const exp = String(Date.now() + 12 * 3600_000);
  return `${exp}.${sign(exp)}`;
}
function validSession(req: Request): boolean {
  const m = /(?:^|;\s*)sess=([^;]+)/.exec(req.headers.cookie ?? "");
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && timingSafeEqual(a, b);
}
const guard = (req: Request, res: Response, next: NextFunction) =>
  validSession(req) ? next() : res.redirect("/admin/login");

// ---------- presentation ----------
const META: Record<OAuthProvider, { name: string; abbr: string; color: string; blurb: string }> = {
  google: { name: "Google", abbr: "G", color: "#4285f4", blurb: "Gmail, Calendar, Drive, Docs" },
  microsoft: { name: "Microsoft 365", abbr: "M", color: "#0f6cbd", blurb: "Outlook, Calendar, OneDrive" },
  canva: { name: "Canva", abbr: "C", color: "#7d2ae8", blurb: "Designs, exports, folders" },
  github: { name: "GitHub", abbr: "GH", color: "#57606a", blurb: "Repos, issues, pull requests" },
};
const configured = (p: OAuthProvider) => listCredentials(p).length > 0;

const CSS = `
:root{--bg:#f5f6f8;--card:#fff;--fg:#14171f;--muted:#667085;--line:#e4e7ec;--accent:#4f46e5;--accent-fg:#fff;--danger:#d92d20;--ok:#12b76a;--shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.08);color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#0b0d12;--card:#141821;--fg:#e8eaf0;--muted:#98a2b3;--line:#262c3a;--accent:#818cf8;--accent-fg:#0b0d12;--danger:#f97066;--shadow:none}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:40px 20px 80px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:28px}
h1{font-size:22px;margin:0;letter-spacing:-.02em} h2{font-size:13px;margin:32px 0 12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.sub{color:var(--muted);font-size:13px;margin:2px 0 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}
.row{display:flex;align-items:center;gap:14px;padding:14px 16px}
.row+.row{border-top:1px solid var(--line)}
.grow{flex:1;min-width:0} .name{font-weight:600} .meta{color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{flex:none;width:38px;height:38px;border-radius:10px;display:grid;place-items:center;color:#fff;font-weight:700;font-size:13px;letter-spacing:-.02em}
.empty{padding:28px 16px;text-align:center;color:var(--muted)}
button,.btn{font:inherit;font-weight:600;font-size:13px;border-radius:9px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:8px 12px;cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.btn:hover{border-color:var(--muted)}
.primary{background:var(--accent);color:var(--accent-fg);border-color:transparent;padding:10px 18px}
.primary:hover{filter:brightness(1.08);border-color:transparent}
.danger{color:var(--danger)} .actions{display:flex;gap:8px;flex:none} form{margin:0}
input[type=text],input[type=password]{width:100%;font:inherit;padding:10px 12px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.tile{position:relative}
.tile input{position:absolute;opacity:0;inset:0;cursor:pointer}
.tile span{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--bg);height:100%}
.tile input:checked+span{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent) inset}
.tile input:focus-visible+span{outline:2px solid var(--accent)}
.tile input:disabled+span{opacity:.5}
.tile small{color:var(--muted);font-size:12px;line-height:1.3}
.pill{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;border:1px solid var(--line);background:var(--card);font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);cursor:pointer;max-width:100%}
.pill b{color:var(--fg);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);flex:none}
.field{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap} .field>div{flex:1;min-width:180px}
label.l{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px}
.hint{color:var(--muted);font-size:12px;margin:6px 0 0;word-break:break-all}
select{font:inherit;width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}@media(max-width:560px){.grid2{grid-template-columns:1fr}}
.note{color:var(--muted);font-size:13px;margin:12px 0 0}
.center{max-width:380px;margin:14vh auto 0}
pre{white-space:pre-wrap;background:var(--bg);padding:12px;border-radius:9px;font-size:13px;border:1px solid var(--line)}
`;

const layout = (title: string, body: string) => `<!doctype html><html lang=en><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content=noindex>
<title>${esc(title)}</title><style>${CSS}</style><body>${body}</body></html>`;

const badge = (p: OAuthProvider) => `<div class=badge style="background:${META[p].color}">${META[p].abbr}</div>`;

export const admin = Router();

admin.get("/admin/login", (_req, res) =>
  res.type("html").send(
    layout(
      "Sign in",
      `<main class=center><div class=card style="padding:24px">
<h1>Account hub</h1><p class=sub>Sign in with the admin password.</p>
<form method=post action=/admin/login style="margin-top:18px">
<input type=password name=password placeholder=Password autofocus required autocomplete=current-password>
<p style="margin:14px 0 0"><button class=primary style="width:100%">Sign in</button></p></form></div></main>`,
    ),
  ),
);

admin.post("/admin/login", (req, res) => {
  if (tooManyFails()) return void res.status(429).send("Too many attempts");
  if (!passwordOk(String(req.body?.password ?? ""))) {
    recordFail();
    return void res.status(401).send("Wrong password");
  }
  res.setHeader("Set-Cookie", `sess=${makeSession()}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=43200`);
  res.redirect("/admin");
});

admin.post("/admin/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "sess=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0");
  res.redirect("/admin/login");
});

admin.get("/admin", guard, (req, res) => {
  const accounts = listAccounts();
  const rows = accounts
    .map((a) => {
      const p = a.provider;
      const app = listCredentials(p).find((c) => c.id === (a.credentialId ?? ENV_CREDENTIAL));
      return `<div class=row>${badge(p)}
<div class=grow><div class=name>${esc(a.label)}</div><div class=meta>${META[p].name} · ${esc(a.email || "unknown identity")} · app: ${esc(app?.name ?? "missing")} · added ${esc(a.addedAt.slice(0, 10))}</div></div>
<div class=actions>
<form method=post action=/admin/connect><input type=hidden name=label value="${esc(a.label)}"><input type=hidden name=provider value="${p}"><input type=hidden name=credential value="${esc(a.credentialId ?? ENV_CREDENTIAL)}"><button title="Re-authorize this account">Reconnect</button></form>
<form method=post action=/admin/remove onsubmit="return confirm('Remove ${esc(a.label).replace(/'/g, "")}?')"><input type=hidden name=label value="${esc(a.label)}"><button class=danger>Remove</button></form>
</div></div>`;
    })
    .join("");

  const first = PROVIDERS.find(configured);
  const tiles = PROVIDERS.map((p) => {
    const ok = configured(p);
    return `<label class=tile><input type=radio name=provider value="${p}" ${ok ? "" : "disabled"} ${p === first ? "checked" : ""} required>
<span>${badge(p)}<b>${META[p].name}</b><small>${ok ? META[p].blurb : "No OAuth app yet (add one below)"}</small></span></label>`;
  }).join("");

  const creds = listCredentials();
  const credOptions = creds
    .map((c) => `<option value="${esc(c.id)}" data-provider="${c.provider}">${esc(META[c.provider].name)} · ${esc(c.name)}</option>`)
    .join("");
  const credRows = creds
    .map((c) => {
      const used = listAccounts(c.provider).filter((a) => (a.credentialId ?? ENV_CREDENTIAL) === c.id).length;
      const action =
        c.id === ENV_CREDENTIAL
          ? `<span class=meta>from .env</span>`
          : `<form method=post action=/admin/credentials/remove onsubmit="return confirm('Remove this OAuth app?')"><input type=hidden name=id value="${esc(c.id)}"><button class=danger ${used ? "disabled title='In use by connected accounts'" : ""}>Remove</button></form>`;
      return `<div class=row>${badge(c.provider)}<div class=grow><div class=name>${esc(c.name)}</div>
<div class=meta>${META[c.provider].name} · client ${esc(c.clientId.slice(0, 18))}${c.clientId.length > 18 ? "…" : ""} · ${used} account${used === 1 ? "" : "s"}</div></div><div class=actions>${action}</div></div>`;
    })
    .join("");
  const providerOptions = PROVIDERS.map((p) => `<option value="${p}">${META[p].name}</option>`).join("");
  const redirectHints = PROVIDERS.map((p) => `${META[p].name}: ${redirectUri(p)}`).join("<br>");
  const mcpUrl = `${config.publicUrl}/mcp`;
  res.type("html").send(
    layout(
      "Account hub",
      `<main>
<header><div><h1>Account hub</h1><p class=sub>${accounts.length} connected account${accounts.length === 1 ? "" : "s"}</p></div>
<form method=post action=/admin/logout><button>Sign out</button></form></header>
<span class=pill onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(mcpUrl)}');this.querySelector('i').textContent='copied'" title="Copy the connector URL">
<span class=dot></span><b>${esc(mcpUrl)}</b><i style="font-style:normal">copy</i></span>

<h2>Connected accounts</h2>
<div class=card>${rows || `<div class=empty>No accounts yet. Add one below.</div>`}</div>

<h2>Add an account</h2>
<form class=card method=post action=/admin/connect style="padding:18px">
<div class=tiles>${tiles}</div>
<div style="margin-bottom:14px"><label class=l for=credential>OAuth app</label>
<select id=credential name=credential required>${credOptions}</select></div>
<div class=field><div><label class=l for=label>Label</label>
<input id=label type=text name=label placeholder="e.g. work, ninf, personal" pattern="[a-zA-Z0-9_\\-]{1,32}" required></div>
<button class=primary>Connect →</button></div>
<p class=note>The label is what Claude uses to pick an account. Re-using a label replaces that account. Use a private window to choose the right identity on the provider's consent screen.</p>
</form>

<h2>OAuth apps</h2>
<div class=card>${credRows || `<div class=empty>No OAuth apps yet.</div>`}</div>
<form class=card method=post action=/admin/credentials style="padding:18px;margin-top:12px" autocomplete=off>
<div class=grid2>
<div><label class=l for=cp>Provider</label><select id=cp name=provider required>${providerOptions}</select></div>
<div><label class=l for=cn>Name</label><input id=cn type=text name=name placeholder="e.g. canva-ninf" maxlength=40 required></div>
<div><label class=l for=ci>Client ID</label><input id=ci type=text name=clientId required></div>
<div><label class=l for=cs>Client secret</label><input id=cs type=password name=clientSecret autocomplete=new-password required></div>
</div>
<p style="margin:14px 0 0"><button class=primary>Save OAuth app</button></p>
<p class=note>Secrets are stored encrypted. Re-using a name replaces that app. Each app needs this redirect URL registered:</p>
<p class=hint>${redirectHints}</p>
</form>
</main>
<script>
(function(){
  var sel=document.getElementById('credential');if(!sel)return;
  var opts=[].slice.call(sel.options);
  function sync(){
    var r=document.querySelector('input[name=provider]:checked');if(!r)return;
    var first=null;
    opts.forEach(function(o){var ok=o.dataset.provider===r.value;o.hidden=!ok;o.disabled=!ok;if(ok&&!first)first=o;});
    if(sel.selectedOptions[0]&&sel.selectedOptions[0].disabled&&first)sel.value=first.value;
  }
  document.querySelectorAll('input[name=provider]').forEach(function(i){i.addEventListener('change',sync);});
  sync();
})();
</script>`,
    ),
  );
});

admin.post("/admin/connect", guard, (req, res) => {
  const provider = req.body?.provider as OAuthProvider;
  const label = String(req.body?.label ?? "");
  if (!PROVIDERS.includes(provider) || !/^[a-zA-Z0-9_-]{1,32}$/.test(label)) {
    return void res.status(400).send("Bad provider or label");
  }
  const credId = String(req.body?.credential ?? "");
  const cred = listCredentials(provider).find((c) => c.id === (credId || undefined) ) ?? listCredentials(provider)[0];
  if (!cred || (credId && cred.id !== credId)) return void res.status(400).send(`No matching ${provider} OAuth app; add one first`);
  res.redirect(buildAuthUrl(provider, label, cred.id));
});

admin.post("/admin/credentials", guard, (req, res) => {
  const provider = req.body?.provider as OAuthProvider;
  const name = String(req.body?.name ?? "").trim().slice(0, 40);
  const clientId = String(req.body?.clientId ?? "").trim();
  const clientSecret = String(req.body?.clientSecret ?? "").trim();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!PROVIDERS.includes(provider) || !slug || !clientId || !clientSecret) return void res.status(400).send("Provider, name, client ID and secret are required");
  const id = `${provider}-${slug}`;
  if (id === ENV_CREDENTIAL) return void res.status(400).send("Reserved name");
  const prev = getState().credentials[id];
  getState().credentials[id] = { id, provider, name, clientId, clientSecret, addedAt: prev?.addedAt ?? new Date().toISOString() };
  save();
  res.redirect("/admin");
});

admin.post("/admin/credentials/remove", guard, (req, res) => {
  const id = String(req.body?.id ?? "");
  if (listAccounts().some((a) => a.credentialId === id)) return void res.status(409).send("OAuth app is used by connected accounts; remove or reconnect them first");
  delete getState().credentials[id];
  save();
  res.redirect("/admin");
});

admin.post("/admin/remove", guard, (req, res) => {
  const label = String(req.body?.label ?? "");
  delete getState().accounts[label];
  invalidate(label);
  save();
  res.redirect("/admin");
});

for (const provider of PROVIDERS) {
  admin.get(`/oauth/${provider}/callback`, async (req, res) => {
    try {
      if (req.query.error) throw new Error(String(req.query.error_description ?? req.query.error));
      const a = await completeConnect(provider, String(req.query.code), String(req.query.state));
      res.type("html").send(
        layout("Connected", `<main class=center><div class=card style="padding:24px"><div class=row style="padding:0 0 16px">${badge(provider)}<div class=grow><div class=name>Connected</div><div class=meta>${esc(a.label)} → ${esc(a.email)}</div></div></div><a class="btn primary" href=/admin>Back to accounts</a></div></main>`),
      );
    } catch (e: any) {
      res.status(400).type("html").send(
        layout("Failed", `<main class=center><div class=card style="padding:24px"><h1>Couldn't connect</h1><pre>${esc(String(e.message ?? e))}</pre><a class=btn href=/admin>Back</a></div></main>`),
      );
    }
  });
}
