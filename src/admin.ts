import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "./config.js";
import { buildAuthUrl, completeConnect, invalidate } from "./providers.js";
import { getState, listAccounts, save, type Provider } from "./store.js";
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

const page = (body: string) => `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>Accounts</title><body style="font-family:system-ui;max-width:640px;margin:8vh auto;padding:0 16px">${body}</body>`;

export const admin = Router();

admin.get("/admin/login", (_req, res) =>
  res.type("html").send(
    page(`<h2>Admin</h2><form method=post action=/admin/login>
<input type=password name=password placeholder=Password autofocus required style="padding:10px;width:100%">
<p><button style="padding:10px 16px">Sign in</button></p></form>`),
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

admin.get("/admin", guard, (_req, res) => {
  const rows = listAccounts()
    .map(
      (a) => `<tr><td><b>${esc(a.label)}</b></td><td>${a.provider}</td><td>${esc(a.email)}</td>
<td><form method=post action=/admin/remove style="margin:0"><input type=hidden name=label value="${esc(a.label)}">
<button>Remove</button></form></td></tr>`,
    )
    .join("");
  res.type("html").send(
    page(`<h2>Connected accounts</h2>
<table cellpadding=6 style="width:100%;text-align:left"><tr><th>Label<th>Provider<th>Email<th></tr>${rows || "<tr><td colspan=4>None yet</td></tr>"}</table>
<h3>Add account</h3>
<form method=post action=/admin/connect>
<input name=label placeholder="label (e.g. work)" pattern="[a-zA-Z0-9_-]{1,32}" required style="padding:8px">
<select name=provider style="padding:8px"><option value=google>Google</option><option value=microsoft>Microsoft 365</option></select>
<button style="padding:8px 14px">Connect</button></form>
<p style="color:#666">Re-using a label replaces that account.</p>`),
  );
});

admin.post("/admin/connect", guard, (req, res) => {
  const provider = req.body?.provider as Provider;
  const label = String(req.body?.label ?? "");
  if (!["google", "microsoft"].includes(provider) || !/^[a-zA-Z0-9_-]{1,32}$/.test(label)) {
    return void res.status(400).send("Bad provider or label");
  }
  const cfg = provider === "google" ? config.google : config.microsoft;
  if (!cfg.clientId || !cfg.clientSecret) return void res.status(400).send(`${provider} client credentials are not configured`);
  res.redirect(buildAuthUrl(provider, label));
});

admin.post("/admin/remove", guard, (req, res) => {
  const label = String(req.body?.label ?? "");
  delete getState().accounts[label];
  invalidate(label);
  save();
  res.redirect("/admin");
});

for (const provider of ["google", "microsoft"] as Provider[]) {
  admin.get(`/oauth/${provider}/callback`, async (req, res) => {
    try {
      if (req.query.error) throw new Error(String(req.query.error_description ?? req.query.error));
      const a = await completeConnect(provider, String(req.query.code), String(req.query.state));
      res.type("html").send(page(`<h2>Connected</h2><p><b>${esc(a.label)}</b> → ${esc(a.email)}</p><p><a href=/admin>Back</a></p>`));
    } catch (e: any) {
      res.status(400).type("html").send(page(`<h2>Failed</h2><pre>${esc(String(e.message ?? e))}</pre><p><a href=/admin>Back</a></p>`));
    }
  });
}
