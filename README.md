# Multi-account MCP server (Google, Microsoft 365, Canva, GitHub)

One remote MCP server that gives Claude access to **several Google, Microsoft 365, Canva and GitHub accounts at once**.
Add it to Claude as a single custom connector; every tool takes an `account` label, and the search/list
tools fan out across all accounts when you omit it.

- Read + write: Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms (Google); Outlook mail, Calendar,
  OneDrive/SharePoint files, Excel ranges (Microsoft); plus `google_api` / `graph_api` escape hatches.
- Canva (`canva_*`): search/list designs, design details, create designs, export (PDF/PNG/PPTX/…), folders,
  asset upload from URL, brand templates + autofill (Enterprise); `canva_api` escape hatch.
- GitHub (`github_*`): repos, search, my work (assigned/review-requested/…), notifications, read/write files,
  commits, Actions runs, issues, pull requests (read, diff, create, review, merge); `github_api` escape hatch.
- Claude → server auth: OAuth 2.1 (dynamic client registration, PKCE), approved with your admin password.
- Account tokens: stored AES-256-GCM encrypted in `DATA_DIR/state.enc`.
- Not available: Microsoft Forms (no public API); Word/PowerPoint get text extraction on read, but no
  structured editing (upload a replacement file instead).

## 1. Google Cloud (once, for all 3 accounts)
1. console.cloud.google.com → new project → enable APIs: Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms.
2. OAuth consent screen → External. Add every account you'll connect as a test user, **then publish the app
   ("In production")**. Apps left in "Testing" get refresh tokens that expire after 7 days. Unverified
   production apps work for up to 100 users; you'll click through a "Google hasn't verified this app" warning.
   (If all accounts belong to one Workspace org you can choose "Internal" and skip this.)
3. Credentials → OAuth client ID → Web application → redirect URI `https://YOUR_HOST/oauth/google/callback`.
4. Put the client id/secret in `.env`.

## 2. Microsoft Entra (once, for both accounts)
1. entra.microsoft.com → App registrations → New → supported account types:
   **Accounts in any organizational directory and personal Microsoft accounts**.
2. Redirect URI (Web): `https://YOUR_HOST/oauth/microsoft/callback`.
3. Certificates & secrets → new client secret. Put id/secret in `.env`.
4. Work/school tenants may require **admin consent** for `Files.ReadWrite.All` / `Sites.ReadWrite.All`.
   If you can't get it, set `MS_SCOPES="offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.ReadWrite"`.

## 2c. GitHub (once, for all accounts)
Recommended: a **GitHub App** (Settings → Developer settings → GitHub Apps → New).
1. Callback URL `https://YOUR_HOST/oauth/github/callback`; keep "Expire user authorization tokens" on; uncheck Webhook.
2. Repository permissions: Contents RW, Issues RW, Pull requests RW, Actions R, Metadata R (+ Commit statuses/Checks R if wanted). Account permissions: none needed.
3. Generate a client secret; put id/secret in `.env` (`GITHUB_CLIENT_ID/SECRET`).
4. **Install the app** on each user/org whose repos Claude should see (App page → Install). User tokens only reach repos where the app is installed *and* the user has access.
5. Connect each GitHub account from `/admin`. Tokens expire after 8h and are refreshed automatically.

Limitation: GitHub Apps cannot read **notifications** (`github_notifications` fails). If you need that, use a classic
**OAuth App** instead (same callback URL) and set `GITHUB_SCOPES="repo read:user notifications"`; its tokens do not expire.

## 3. Deploy on the VM
```bash
cp .env.example .env     # fill in; generate secrets:
openssl rand -base64 32  # -> ENCRYPTION_KEY
openssl rand -base64 24  # -> ADMIN_PASSWORD
# set PUBLIC_URL=https://your-hostname in .env (TLS/reverse proxy is yours; point it at port 3000)
docker compose up -d --build
```
State lives in the bind-mounted `./data` folder (the container runs as uid 1000, so on Linux run `sudo chown -R 1000:1000 data` once). Back up `./data` **and** keep `ENCRYPTION_KEY`; without the key the state can't be read.

## 4. Link your accounts
Open `https://YOUR_HOST/admin`, sign in, then for each account pick a provider tile and a label (e.g. `work`, `ninf`,
`sinformania`, `m365-a`) and provider, and complete the consent screen. Use a private window or the
account chooser to pick the right identity each time.

## 2b. Canva (once, for all accounts)
1. canva.com/developers → Your integrations → Create integration (private). Enable the scopes: `profile:read`,
   `design:meta:read`, `design:content:read`, `design:content:write`, `asset:read`, `asset:write`,
   `folder:read`, `folder:write` (+ `brandtemplate:*:read` on Enterprise).
2. Redirect URL: `https://YOUR_HOST/oauth/canva/callback`. Copy client id/secret into `.env` (`CANVA_CLIENT_ID/SECRET`).
3. Connect each Canva account from `/admin` (use a private window to pick the right identity). Canva
   private integrations may be limited to your own team; check Canva's docs if connecting a different account fails.

## 5. Add to Claude
Claude → Settings → Connectors → Add custom connector → URL `https://YOUR_HOST/mcp`.
Claude opens the approval page; enter the admin password. Then try: *"List my connected accounts"*, *"Export my latest Canva design as PDF"*, *"Which PRs need my review?"*,
*"Search all accounts for emails from X this week"*.

## Notes
- Tool annotations mark read-only tools, so Claude can auto-allow reads while asking before sends/edits/deletes.
- Rotate access: remove an account in `/admin`, or revoke the app in the Google/Microsoft account security page.
- Anyone with the admin password can connect a client to this server. Use a long random one.

## Multiple OAuth apps per provider

Client ID/secret can be added in `/admin` → **OAuth apps** (secrets are stored inside the encrypted state file), in addition to or instead of the `.env` values. Pick the app when connecting an account. Useful for Canva: a draft/public integration only authorizes its owner, so create one integration per Canva account and add each here. Every app needs the same redirect URL (`${PUBLIC_URL}/oauth/<provider>/callback`).
