# CLAUDE.md

Self-hosted **multi-account MCP server**. One remote MCP endpoint (`/mcp`) lets Claude use several
accounts per provider at once: Google Workspace, Microsoft 365, Canva and GitHub. Every tool takes
an `account` label; list/search tools fan out over all accounts of that provider when it is omitted.

## Commands
- `npm run dev` – run with tsx, loading `.env` via `--env-file` (the app does not read `.env` itself; Docker injects it via `env_file`)
- `npm run build` – `tsc` to `dist/` (this is also the typecheck; there are no tests or linter)
- `npm start` – run the built server
- `docker compose up -d --build` – production (publishes port 5757, bind-mounts `./data` to `/data`; put your own reverse proxy in front; the entrypoint chowns it to `node` then drops root)

## Architecture (`src/`)
- `server.ts` – Express app. `mcpAuthRouter` exposes OAuth 2.1 for **Claude → this server**; `POST /mcp`
  is bearer-protected and builds a fresh stateless `McpServer` per request, calling every `register*`.
- `auth-provider.ts` – the MCP OAuth provider (dynamic client registration, PKCE). Approval = admin password.
- `admin.ts` – `/admin` UI (session cookie): add/remove accounts, OAuth callbacks
  (`/oauth/<google|microsoft|canva>/callback`), (modern single-file UI, light/dark, no client-side framework).
- `store.ts` – single AES-256-GCM encrypted state file (`DATA_DIR/state.enc`): accounts, OAuth app credentials (client id/secret), MCP clients, tokens. `listCredentials()`/`getCredential()` merge the `.env` client (id `env`) with those added in /admin.
  `Provider = OAuthProvider = "google" | "microsoft" | "canva" | "github"`; all providers use OAuth.
- `providers.ts` – Google/Microsoft/Canva/GitHub OAuth connect + refresh (`accessToken(label)`; Canva uses PKCE + Basic
  client auth).
- `api.ts` – the only place that talks to upstream APIs: `api(label, provider, url, opts)`. Adds the bearer
  token, retries once on 401, enforces a **host allowlist**, optional `pages` to follow `Link: rel=next`,
  and `out()` truncates output to 60k chars.
- `tools/common.ts` – `tool()` wrapper (error → `isError`, annotations), `fanOut()`, `list_accounts`.
- `tools/{google,microsoft,canva,github}.ts` – one `registerX(server)` each.

## Account model
| Provider | Auth | Stored on account | Allowed API host |
|---|---|---|---|
| google | OAuth refresh token | `refreshToken` | `*.googleapis.com` |
| microsoft | OAuth refresh token (rotates) | `refreshToken` | `graph.microsoft.com` |
| canva | OAuth 2.0 + PKCE (Canva Connect), refresh token is single-use and rotates | `refreshToken` | `api.canva.com` |
| github | GitHub App user-to-server OAuth (8h token + rotating refresh token), or OAuth App (non-expiring `token`) | `refreshToken` or `token` | `api.github.com` |

Each account stores `credentialId` (which OAuth app connected it; absent = `.env`). Refresh uses the same app, so several apps per provider can coexist (e.g. one Canva draft integration per Canva account, since draft/public integrations only authorize their owner). Apps are managed in /admin → OAuth apps; an app in use can't be removed.

Labels are user-chosen (`[a-zA-Z0-9_-]{1,32}`); re-using a label replaces the account.

## Conventions
- ESM + NodeNext: relative imports end in `.js`. TypeScript `strict`.
- Define tools with `tool(server, name, description, zodShape, handler, hint)`. Return plain data; `out()`
  stringifies. Set `{ readOnly: true }` for reads and `{ destructive: true }` for sends/deletes/merges/escape
  hatches so Claude can auto-allow reads and confirm the rest.
- Use `accountOrAll` + `fanOut(provider, acc, fn)` for tools that make sense across accounts (search, inbox,
  todo); use required `account` when the call targets a specific resource (a repo, a course).
- Always call upstream through `api()` – never `fetch` with a stored token directly. Never follow redirects/links
  to other hosts with the bearer token (pagination re-checks the host).
- Slim responses: pick the fields the model needs, strip HTML, don't dump raw API objects.
- Each provider keeps a `*_api` escape hatch (`google_api`, `graph_api`, `canva_api`, `github_api`) for
  anything not covered; prefer adding a proper tool when a call recurs.

## Adding a provider
1. Extend `OAuthProvider` and `PROVIDERS` in `store.ts`; add the host rule in `api.ts`
   (`ALLOWED_HOSTS`, `defaultHeaders`).
2. Add config in `config.ts`, auth/token URLs + identity lookup in `providers.ts`, and a `META` entry in `admin.ts`
   (tiles and callback routes are generated from `PROVIDERS`).
3. Create `tools/<provider>.ts`, register it in `server.ts`, document it in README + `.env.example`.

## Gotchas
- Secrets: `.env`, `data/` and `state.enc` must never be committed (already gitignored). Losing
  `ENCRYPTION_KEY` makes the state unreadable.
- Google apps in "Testing" mode have refresh tokens that expire after 7 days – publish the app.
- Microsoft rotates refresh tokens; `accessToken()` persists the new one.
- GitHub App tokens only reach repos where the app is installed; they cannot read notifications (use an OAuth App
  with `GITHUB_SCOPES` for that). `search` and `github_my_work` only see what the token sees.
- Canva Connect: the integration must have the scopes enabled in the Canva developer portal before they can be
  requested; brand templates/autofill need Canva Enterprise; Canva has no email in its API, so the account
  shows the display name. Pagination uses `continuation` tokens (exposed as tool params), not Link headers.
- Tool descriptions are what Claude sees – keep them accurate when behaviour changes.
