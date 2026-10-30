import "./setup.ts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { buildServer } from "../src/mcp.ts";
import { getState } from "../src/store.ts";
import { confirmTotpSetup, beginTotpSetup } from "../src/security.ts";
import { hotp, stepOf } from "../src/totp.ts";

let server: Server;
let base = "";
before(async () => {
  buildServer();
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  const s = getState();
  s.clients.abc = { client_id: "abc", client_name: "<img src=x onerror=alert(1)>", redirect_uris: ["https://claude.ai/cb"], client_id_issued_at: 1 };
  s.accounts.work = { label: "work", provider: "github", email: "me", scopes: "", addedAt: "2026-01-01", token: "t" } as any;
});
after(() => server.close());

const jar = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("=")).join("; ");
const form = (o: Record<string, string>) => ({ method: "POST", redirect: "manual" as const, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) });
async function login(): Promise<string> {
  const r = await fetch(`${base}/admin/login`, form({ password: "correct horse" }));
  assert.equal(r.status, 302);
  return jar(r);
}
const authed = (cookie: string, init: RequestInit = {}) => ({ redirect: "manual" as const, ...init, headers: { cookie, ...(init.headers as object) } });

test("public assets and security headers", async () => {
  const svg = await fetch(`${base}/favicon.svg`);
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-type")!, /svg/);
  assert.equal((await fetch(`${base}/favicon.ico`)).status, 200);
  assert.equal((await fetch(`${base}/assets/ui.css`)).status, 200);
  const page = await fetch(`${base}/admin/login`);
  assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(await (await fetch(`${base}/healthz`)).text(), "ok");
});

test("admin pages need a session", async () => {
  for (const p of ["/admin", "/admin/activity", "/admin/tools", "/admin/clients", "/admin/settings", "/admin/account/work"]) {
    const r = await fetch(`${base}${p}`, { redirect: "manual" });
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get("location"), "/admin/login");
  }
  const post = await fetch(`${base}/admin/tools`, form({ group: "slack", preset: "all" }));
  assert.equal(post.status, 302);
});

test("wrong password is refused with a styled page", async () => {
  const r = await fetch(`${base}/admin/login`, form({ password: "nope" }));
  assert.equal(r.status, 401);
  assert.match(await r.text(), /isn&#39;t right/);
});

test("every admin page renders once signed in", async () => {
  const c = await login();
  for (const [p, needle] of [["/admin", "work"], ["/admin/add", "Add account"], ["/admin/apps", "OAuth apps"], ["/admin/activity", "Activity"], ["/admin/tools", "slack_send"], ["/admin/clients", "Clients"], ["/admin/settings", "Backup"], ["/admin/account/work", "Read-only"]] as const) {
    const r = await fetch(`${base}${p}`, authed(c));
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), new RegExp(needle), p);
  }
  assert.equal((await fetch(`${base}/admin/account/ghost`, authed(c))).status, 404);
});

test("account settings: read-only, group and a single default per service", async () => {
  const c = await login();
  getState().accounts.second = { label: "second", provider: "github", email: "x", scopes: "", addedAt: "2026-01-01", token: "t", isDefault: true } as any;
  const r = await fetch(`${base}/admin/account/work`, authed(c, form({ group: "team", readOnly: "on", isDefault: "on" })));
  assert.equal(r.status, 302);
  const a = getState().accounts;
  assert.deepEqual([a.work.group, a.work.readOnly, a.work.isDefault, a.second.isDefault], ["team", true, true, undefined]);
  const bad = await fetch(`${base}/admin/account/work`, authed(c, form({ group: "second" })));
  assert.equal(bad.status, 400); // a group can't shadow an account label
});

test("tool switches persist and per-group presets work", async () => {
  const c = await login();
  await fetch(`${base}/admin/tools`, authed(c, form({ group: "slack", preset: "reads" })));
  const off = getState().settings.disabledTools;
  assert.ok(off.includes("slack_send") && off.includes("slack_api") && !off.includes("slack_users"));
  await fetch(`${base}/admin/tools`, authed(c, form({ group: "slack", preset: "all" })));
  assert.ok(!getState().settings.disabledTools.some((n) => n.startsWith("slack_")));
});

test("clients can be revoked, which also drops their tokens", async () => {
  const c = await login();
  const s = getState();
  s.access.tok = { clientId: "abc", expires: Date.now() + 1e6 };
  s.refresh.ref = { clientId: "abc" };
  const page = await (await fetch(`${base}/admin/clients`, authed(c))).text();
  assert.ok(!page.includes("<img src=x"), "client names must be escaped");
  await fetch(`${base}/admin/clients/revoke`, authed(c, form({ id: "abc" })));
  assert.deepEqual([s.clients.abc, s.access.tok, s.refresh.ref], [undefined, undefined, undefined]);
});

const AUTHORIZE = `/authorize?response_type=code&client_id=abc&redirect_uri=${encodeURIComponent("https://claude.ai/cb")}&code_challenge=${"a".repeat(43)}&code_challenge_method=S256&state=xyz`;

test("authorization page escapes the client name, refuses a wrong password and honours Deny", async () => {
  getState().clients.abc = { client_id: "abc", client_name: "<img src=x onerror=alert(1)>", redirect_uris: ["https://claude.ai/cb"], client_id_issued_at: 1 };
  const page = await (await fetch(`${base}${AUTHORIZE}`)).text();
  assert.ok(!page.includes("<img src=x onerror"), "must be escaped");
  assert.ok(!page.includes("work"), "must not reveal account labels");
  const fields = { client_id: "abc", redirect_uri: "https://claude.ai/cb", code_challenge: "a".repeat(43), state: "xyz" };
  const wrong = await fetch(`${base}/authorize/confirm`, form({ ...fields, password: "nope", action: "approve" }));
  assert.equal(wrong.status, 401);
  const deny = await fetch(`${base}/authorize/confirm`, form({ ...fields, password: "", action: "deny" }));
  assert.equal(deny.status, 302);
  assert.equal(deny.headers.get("location"), "https://claude.ai/cb?error=access_denied&state=xyz");
  const ok = await fetch(`${base}/authorize/confirm`, form({ ...fields, password: "correct horse", action: "approve" }));
  assert.match(ok.headers.get("location")!, /^https:\/\/claude\.ai\/cb\?code=.+&state=xyz$/);
  const evil = await fetch(`${base}/authorize/confirm`, form({ ...fields, redirect_uri: "https://evil.example/cb", password: "correct horse", action: "approve" }));
  assert.equal(evil.status, 400);
});

test("pages link fingerprinted assets, so stale caches can't mix old CSS with new HTML", async () => {
  const html = await (await fetch(`${base}/admin/login`)).text();
  assert.match(html, /\/assets\/ui\.css\?v=[0-9a-f]{8}/);
  const c = await login();
  assert.match(await (await fetch(`${base}/admin`, authed(c))).text(), /\/assets\/admin\.js\?v=[0-9a-f]{8}/);
});

test("clients without a session can be cleaned up in one go", async () => {
  const c = await login();
  const s = getState();
  s.clients = {
    live: { client_id: "live", client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] },
    idle1: { client_id: "idle1", client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] },
    idle2: { client_id: "idle2", client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] },
  };
  s.refresh.r = { clientId: "live" };
  assert.match(await (await fetch(`${base}/admin/clients`, authed(c))).text(), /Remove 2 without a session/);
  await fetch(`${base}/admin/clients/cleanup`, authed(c, form({})));
  assert.deepEqual(Object.keys(s.clients), ["live"]);
});

test("the activity page offers tabs with counts", async () => {
  const c = await login();
  const html = await (await fetch(`${base}/admin/activity`, authed(c))).text();
  assert.match(html, /class=tabs/);
  assert.match(html, /aria-current=page>All/);
});

test("two-step sign-in guards both the admin login and the approval page", async () => {
  const c = await login();
  getState().clients.abc = { client_id: "abc", client_name: "Claude", redirect_uris: ["https://claude.ai/cb"], client_id_issued_at: 1 };
  const t = beginTotpSetup("admin");
  const step = stepOf();
  assert.ok(confirmTotpSetup(hotp(t.secret, step)));
  getState().settings.totp!.lastStep = step - 5; // let the next code through in this test
  try {
    // password alone no longer opens a session
    const first = await fetch(`${base}/admin/login`, form({ password: "correct horse" }));
    assert.equal(first.headers.get("location"), "/admin/login/code");
    const pre = jar(first);
    assert.equal((await fetch(`${base}/admin`, authed(pre))).headers.get("location"), "/admin/login");
    const badCode = await fetch(`${base}/admin/login/code`, authed(pre, form({ code: "000000" })));
    assert.equal(badCode.status, 401);
    const good = await fetch(`${base}/admin/login/code`, authed(pre, form({ code: hotp(t.secret, step + 1) })));
    assert.equal(good.status, 302);
    assert.equal((await fetch(`${base}/admin`, authed(jar(good)))).status, 200);
    // the consent page also asks for a code
    assert.match(await (await fetch(`${base}${AUTHORIZE}`)).text(), /Authenticator code/);
    const fields = { client_id: "abc", redirect_uri: "https://claude.ai/cb", code_challenge: "a".repeat(43), state: "xyz", action: "approve" };
    assert.equal((await fetch(`${base}/authorize/confirm`, form({ ...fields, password: "correct horse", code: "000000" }))).status, 401);
  } finally {
    delete getState().settings.totp;
    void c;
  }
});
