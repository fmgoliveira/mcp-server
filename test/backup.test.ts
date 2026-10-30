import "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { getState } from "../src/store.ts";
import { exportBackup, importBackup } from "../src/backup.ts";

test("backup round trip restores accounts, apps and settings but keeps MCP clients", () => {
  const s = getState();
  s.accounts = { work: { label: "work", provider: "github", email: "me", scopes: "", addedAt: "2026-01-01", token: "ghp_x", readOnly: true } as any };
  s.credentials = { "canva-a": { id: "canva-a", provider: "canva", name: "a", clientId: "id", clientSecret: "sec", addedAt: "2026-01-01" } as any };
  s.settings.disabledTools = ["slack_send"];
  s.clients = { c1: { client_id: "c1", client_name: "Claude" } };
  const file = exportBackup("long passphrase");
  assert.ok(!file.includes("ghp_x"), "backup must not contain plaintext secrets");

  s.accounts = {};
  s.credentials = {};
  s.settings.disabledTools = [];
  assert.equal(importBackup("long passphrase", file), 1);
  const after = getState();
  assert.equal(after.accounts.work.token, "ghp_x");
  assert.equal(after.accounts.work.readOnly, true);
  assert.equal(after.credentials["canva-a"].clientSecret, "sec");
  assert.deepEqual(after.settings.disabledTools, ["slack_send"]);
  assert.ok(after.clients.c1);
});

test("bad passphrase, short passphrase and tampered labels are rejected", () => {
  const file = exportBackup("long passphrase");
  assert.throws(() => importBackup("wrong passphrase", file), /Wrong passphrase/);
  assert.throws(() => exportBackup("short"), /at least 8/);
});
