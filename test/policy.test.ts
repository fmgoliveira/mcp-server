import "./setup.ts";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { getState } from "../src/store.ts";
import { assertAllowed, providerOf, resolveAccount } from "../src/policy.ts";
import { account, accountOrAll, fanOut, tool } from "../src/tools/common.ts";
import { daysLeft } from "../src/health.ts";

const acc = (label: string, provider: any, extra: object = {}) =>
  (getState().accounts[label] = { label, provider, email: `${label}@x`, scopes: "", addedAt: "2026-01-01", ...extra } as any);

beforeEach(() => {
  const s = getState();
  s.accounts = {};
  s.activity = [];
  s.settings.disabledTools = [];
});

test("tool names map to services", () => {
  assert.equal(providerOf("gmail_search"), "google");
  assert.equal(providerOf("ms_calendar_list_events"), "microsoft");
  assert.equal(providerOf("jira_issue"), "atlassian");
  assert.equal(providerOf("list_accounts"), undefined);
});

test("an omitted account resolves to the default, or the only account", () => {
  acc("a", "github");
  assert.equal(resolveAccount("github_repos", ""), "a");
  acc("b", "github");
  assert.throws(() => resolveAccount("github_repos", ""), /Several github accounts/);
  getState().accounts.b.isDefault = true;
  assert.equal(resolveAccount("github_repos", ""), "b");
  assert.equal(resolveAccount("github_repos", "a"), "a");
  assert.throws(() => resolveAccount("gitlab_projects", ""), /No gitlab accounts/);
});

test("a group name is not accepted where a single account is needed", () => {
  acc("a", "github", { group: "work" });
  assert.throws(() => resolveAccount("github_repos", "work"), /is a group/);
});

test("read-only accounts only allow reads and GET escape hatches", () => {
  acc("ro", "github", { readOnly: true });
  acc("rw", "github");
  assertAllowed("github_repos", { readOnly: true }, "ro", {});
  assert.throws(() => assertAllowed("github_create_issue", {}, "ro", {}), /read-only/);
  assertAllowed("github_create_issue", {}, "rw", {});
  assertAllowed("github_api", { destructive: true }, "ro", { method: "GET" });
  assert.throws(() => assertAllowed("github_api", { destructive: true }, "ro", { method: "DELETE" }), /read-only/);
  acc("lin", "linear", { readOnly: true });
  assertAllowed("linear_api", { destructive: true }, "lin", { query: "query { viewer { id } }" });
  assert.throws(() => assertAllowed("linear_api", { destructive: true }, "lin", { query: "# hi\nmutation { issueDelete(id: \"1\") { success } }" }), /read-only/);
});

// a minimal stand-in for McpServer that captures what tool() registers
const fakeServer = () => {
  const tools = new Map<string, (args: any, extra?: any) => Promise<any>>();
  return { tools, registerTool: (n: string, _c: unknown, cb: any) => void tools.set(n, cb) } as any;
};

test("tool() enforces read-only, fills the default account and logs the call", async () => {
  acc("ro", "gitlab", { readOnly: true, isDefault: true });
  const s = fakeServer();
  tool(s, "gitlab_comment", "write", { account, body: z.string() }, async (a) => `commented via ${a.account}`, { destructive: true });
  tool(s, "gitlab_projects", "read", { account: accountOrAll }, async () => "listed", { readOnly: true });

  const blocked = await s.tools.get("gitlab_comment")({ account: "", body: "hi" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /read-only/);
  const read = await s.tools.get("gitlab_projects")({});
  assert.equal(read.isError, undefined);

  const [first, second] = getState().activity;
  assert.deepEqual([first.tool, first.account, first.ok, first.blocked], ["gitlab_comment", "ro", false, true]);
  assert.deepEqual([second.tool, second.ok], ["gitlab_projects", true]);

  getState().accounts.ro.readOnly = false;
  const ok = await s.tools.get("gitlab_comment")({ account: "", body: "hi" });
  assert.match(ok.content[0].text, /commented via ro/);
});

test("switched-off tools are not registered", () => {
  getState().settings.disabledTools = ["slack_send"];
  const s = fakeServer();
  tool(s, "slack_send", "x", { account }, async () => "x", { destructive: true });
  tool(s, "slack_users", "x", { account }, async () => "x", { readOnly: true });
  assert.deepEqual([...s.tools.keys()], ["slack_users"]);
});

test("fanOut accepts a label, a group, or everything", async () => {
  acc("a", "github", { group: "work" });
  acc("b", "github", { group: "work" });
  acc("c", "github");
  const run = (target?: string) => fanOut("github", target, async (l) => l);
  assert.equal(await run("c"), "c");
  assert.deepEqual((await run("work") as any[]).map((r) => r.account), ["a", "b"]);
  assert.equal(((await run()) as any[]).length, 3);
  await assert.rejects(() => fanOut("github", "nobody", async (l) => { throw new Error(`Unknown account "${l}"`); }), /Unknown account/);
});

test("daysLeft", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  assert.equal(daysLeft({ expiresAt: "2026-10-11T00:00:00Z" } as any, now), 10);
  assert.ok(daysLeft({ expiresAt: "2026-09-29T00:00:00Z" } as any, now)! < 0);
  assert.equal(daysLeft({} as any, now), undefined);
});

test("slack_api is read-only only for read-style methods", () => {
  acc("sl", "slack", { readOnly: true });
  assertAllowed("slack_api", { destructive: true }, "sl", { method: "conversations.info" });
  assert.throws(() => assertAllowed("slack_api", { destructive: true }, "sl", { method: "chat.delete" }), /read-only/);
});
