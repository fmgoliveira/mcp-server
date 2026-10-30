# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it and the impact you
see. You'll get a first reply within a few days.

## What this server protects

This server holds long-lived credentials (OAuth refresh tokens, API tokens) for your accounts and lets an MCP client act
on them. Treat it like a password manager:

- **Encryption at rest.** All accounts, OAuth app secrets, MCP clients and tokens live in one AES-256-GCM encrypted file
  (`DATA_DIR/state.enc`). The key is `ENCRYPTION_KEY`; without it the file cannot be read, and anyone who has both can read
  everything.
- **One admin password.** `ADMIN_PASSWORD` unlocks `/admin` and approves new MCP clients on the authorization page. There are
  no user accounts or roles. Anyone with the password can connect a client that can use every account.
- **Brute-force limit.** Ten failed password attempts in 15 minutes block further attempts. The counter is in memory and
  resets on restart.
- **Upstream allowlist.** Tool calls only reach the hosts listed in `src/api.ts` (and the base URL of a GitLab account).
  Bearer tokens are never sent to a host outside that list, including when following pagination links.
- **Browser hardening.** Admin and authorization pages send a strict Content-Security-Policy, forbid framing and use
  `SameSite=Strict` session cookies.

## Hardening checklist

- Serve the server over HTTPS only (the session cookie is `Secure`). Put a reverse proxy such as Caddy or nginx in front.
- Use long random values for `ADMIN_PASSWORD` and `ENCRYPTION_KEY`, and keep `.env` and `data/` out of version control and
  out of backups you don't trust.
- Give each OAuth app and API token the minimum scopes you need, and prefer read-only tokens where writes aren't required.
- Back up `./data` **and** the key separately; rotate access by removing an account in `/admin` and revoking the grant at
  the provider.
- Run one instance per person or team that trusts each other. It is not designed to be multi-tenant.
