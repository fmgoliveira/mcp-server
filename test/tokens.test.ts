import "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { checkHost } from "../src/api.ts";
import { authHeaders, normalizeBaseUrl, normalizeSiteUrl } from "../src/tokens.ts";

const acc = (extra: object = {}) => ({ label: "x", provider: "github", email: "", scopes: "", addedAt: "", ...extra }) as any;

test("upstream host allowlist", () => {
  assert.doesNotThrow(() => checkHost("github", acc(), new URL("https://api.github.com/user")));
  assert.throws(() => checkHost("github", acc(), new URL("https://evil.example/user")), /not allowed/);
  assert.throws(() => checkHost("github", acc(), new URL("http://api.github.com/user")), /not allowed/);
  assert.doesNotThrow(() => checkHost("google", acc(), new URL("https://gmail.googleapis.com/x")));
  assert.throws(() => checkHost("google", acc(), new URL("https://googleapis.com.evil.example/x")), /not allowed/);
  assert.doesNotThrow(() => checkHost("slack", acc(), new URL("https://slack.com/api/auth.test")));
  assert.doesNotThrow(() => checkHost("linear", acc(), new URL("https://api.linear.app/graphql")));
});

test("self-hosted services only reach the account's own host", () => {
  const gl = acc({ provider: "gitlab", baseUrl: "https://git.acme.example" });
  assert.doesNotThrow(() => checkHost("gitlab", gl, new URL("https://git.acme.example/api/v4/user")));
  assert.throws(() => checkHost("gitlab", gl, new URL("https://gitlab.com/api/v4/user")), /not allowed/);
  const at = acc({ provider: "atlassian", baseUrl: "https://acme.atlassian.net" });
  assert.doesNotThrow(() => checkHost("atlassian", at, new URL("https://acme.atlassian.net/rest/api/3/myself")));
  assert.throws(() => checkHost("atlassian", at, new URL("https://other.atlassian.net/rest/api/3/myself")), /not allowed/);
  assert.throws(() => checkHost("atlassian", acc({ provider: "atlassian" }), new URL("https://acme.atlassian.net/x")), /not allowed/);
});

test("auth headers per service", () => {
  assert.equal(authHeaders("github", "t").authorization, "Bearer t");
  assert.equal(authHeaders("discord", "t").authorization, "Bot t");
  assert.equal(authHeaders("figma", "t")["x-figma-token"], "t");
  assert.equal(authHeaders("linear", "lin_api_x").authorization, "lin_api_x");
  assert.equal(authHeaders("linear", "lin_oauth_x").authorization, "Bearer lin_oauth_x");
  assert.equal(authHeaders("atlassian", "tok", "me@x.com").authorization, `Basic ${Buffer.from("me@x.com:tok").toString("base64")}`);
  assert.ok(authHeaders("notion", "t")["notion-version"]);
});

test("base URLs must be https", () => {
  assert.equal(normalizeBaseUrl(""), "https://gitlab.com");
  assert.throws(() => normalizeBaseUrl("http://git.example"), /https/);
  assert.equal(normalizeSiteUrl("https://acme.atlassian.net/jira/"), "https://acme.atlassian.net");
  assert.throws(() => normalizeSiteUrl(""), /site URL/);
  assert.throws(() => normalizeSiteUrl("http://acme.atlassian.net"), /https/);
});
