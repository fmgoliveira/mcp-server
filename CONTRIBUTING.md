# Contributing

Thanks for helping out. Bug reports, provider requests and pull requests are all welcome.

## Set up

```bash
git clone https://github.com/fmgoliveira/mcp-server && cd mcp-server
npm install
cp .env.example .env      # set PUBLIC_URL, ADMIN_PASSWORD and ENCRYPTION_KEY (openssl rand -base64 32)
npm run dev               # http://localhost:3000/admin
```

For OAuth sign-in to work locally, `PUBLIC_URL` has to be a URL the provider can redirect back to. A tunnel such as
`cloudflared` or `ngrok` works well. API-token services (GitLab, Cloudflare, Discord, Figma) need no tunnel.

`npm run build` runs the TypeScript compiler and is also the typecheck. There is no test suite yet, so please describe how
you checked your change in the pull request.

## Code conventions

- ESM with NodeNext: relative imports end in `.js`. TypeScript is `strict`.
- Define tools with `tool(server, name, description, zodShape, handler, hint)` from `src/tools/common.ts`. Mark reads with
  `{ readOnly: true }` and anything that sends, deletes or merges with `{ destructive: true }`.
- Call upstream APIs only through `api()` in `src/api.ts`. Never `fetch` with a stored token directly, and never follow
  links to other hosts with a bearer token.
- Keep responses slim: pick the fields the model needs and strip HTML. Tool descriptions are what Claude reads, so keep
  them accurate.
- Admin UI: server-rendered HTML in `src/admin.ts`, shared pieces in `src/ui.ts`, styles and the small client script in
  `public/assets/`. No frameworks and no third-party requests. Escape every dynamic value with `esc()`.

## Adding a provider

1. Extend `OAuthProvider` (or `TokenProvider`) in `src/store.ts` and add the host rule in `src/api.ts`.
2. Add config in `src/config.ts`, auth and token URLs in `src/providers.ts` (or `src/tokens.ts` for API tokens), and an
   entry in `META` in `src/ui.ts`.
3. Create `src/tools/<provider>.ts` with a `registerX(server)` function and register it in `src/server.ts`.
4. Document the setup steps in the README and add any new variables to `.env.example`.

## Pull requests

- Keep each pull request focused, and explain the why.
- Never commit secrets, `.env`, `data/` or `state.enc`.
- Security issues go through the private channel in [SECURITY.md](SECURITY.md), not a public issue.
