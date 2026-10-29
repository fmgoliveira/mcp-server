# Multi-account MCP server (Google + Microsoft 365)

One remote MCP server that gives Claude access to **several Google and Microsoft 365 accounts at once**.
Add it to Claude as a single custom connector; every tool takes an `account` label, and the search/list
tools fan out across all accounts when you omit it.

- Read + write: Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms (Google); Outlook mail, Calendar,
  OneDrive/SharePoint files, Excel ranges (Microsoft); plus `google_api` / `graph_api` escape hatches.
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

## 3. Deploy on the VM
```bash
cp .env.example .env     # fill in; generate secrets:
openssl rand -base64 32  # -> ENCRYPTION_KEY
openssl rand -base64 24  # -> ADMIN_PASSWORD
# edit Caddyfile hostname, set PUBLIC_URL=https://same-hostname in .env
docker compose up -d --build
```
Back up the `mcp-data` volume **and** keep `ENCRYPTION_KEY`; without the key the state can't be read.

## 4. Link your accounts
Open `https://YOUR_HOST/admin`, sign in, then for each account choose a label (e.g. `work`, `ninf`,
`sinformania`, `m365-a`) and provider, and complete the consent screen. Use a private window or the
account chooser to pick the right identity each time.

## 5. Add to Claude
Claude → Settings → Connectors → Add custom connector → URL `https://YOUR_HOST/mcp`.
Claude opens the approval page; enter the admin password. Then try: *"List my connected accounts"*,
*"Search all accounts for emails from X this week"*.

## Notes
- Tool annotations mark read-only tools, so Claude can auto-allow reads while asking before sends/edits/deletes.
- Rotate access: remove an account in `/admin`, or revoke the app in the Google/Microsoft account security page.
- Anyone with the admin password can connect a client to this server. Use a long random one.
