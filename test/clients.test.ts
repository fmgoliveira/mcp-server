import "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { getState } from "../src/store.ts";
import { listClients, provider, revokeClient } from "../src/auth-provider.ts";

const meta = (name: string, uris: string[]) => ({ client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none" }) as any;

test("registering the same public client twice reuses the entry", async () => {
  getState().clients = {};
  const store = provider.clientsStore as any;
  const a = await store.registerClient(meta("Claude", ["https://claude.ai/cb"]));
  const b = await store.registerClient(meta("Claude", ["https://claude.ai/cb"]));
  assert.equal(a.client_id, b.client_id);
  const c = await store.registerClient(meta("Claude", ["https://claude.ai/other"]));
  assert.notEqual(a.client_id, c.client_id);
  const d = await store.registerClient({ ...meta("Claude", ["https://claude.ai/cb"]), client_secret: "s" });
  assert.notEqual(a.client_id, d.client_id, "clients with a secret are never shared");
  assert.equal(listClients().length, 3);
});

test("revoking a client removes its tokens and codes", () => {
  const s = getState();
  s.clients = { x: { client_id: "x", client_name: "X", redirect_uris: [] } };
  s.access.t1 = { clientId: "x", expires: Date.now() + 1000 };
  s.refresh.r1 = { clientId: "x" };
  s.codes.c1 = { clientId: "x", challenge: "", redirectUri: "", expires: Date.now() + 1000 };
  assert.equal(listClients()[0].sessions, 1);
  assert.equal(revokeClient("x"), true);
  assert.deepEqual([s.clients.x, s.access.t1, s.refresh.r1, s.codes.c1], [undefined, undefined, undefined, undefined]);
  assert.equal(revokeClient("x"), false);
});
