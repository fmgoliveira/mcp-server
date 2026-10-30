// Passphrase-protected export/import of accounts, OAuth apps and settings. MCP clients and their tokens are not
// included: after a restore, Claude keeps its existing connection to this server.
import { openBackup, sealBackup } from "./crypto.js";
import { getState, replaceState, type Account, type Credential, type Settings } from "./store.js";

interface BackupFile {
  version: 1;
  exportedAt: string;
  accounts: Record<string, Account>;
  credentials: Record<string, Credential>;
  settings: Settings;
}

export function exportBackup(passphrase: string): string {
  if (passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters");
  const s = getState();
  const file: BackupFile = { version: 1, exportedAt: new Date().toISOString(), accounts: s.accounts, credentials: s.credentials, settings: s.settings };
  return sealBackup(passphrase, JSON.stringify(file));
}

/** Replaces accounts, OAuth apps and settings with the backup's. Returns how many accounts were restored. */
export function importBackup(passphrase: string, sealed: string): number {
  const data = JSON.parse(openBackup(passphrase, sealed)) as Partial<BackupFile>;
  if (data.version !== 1 || typeof data.accounts !== "object" || typeof data.credentials !== "object") throw new Error("Unsupported backup version");
  for (const [k, a] of Object.entries(data.accounts!)) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(k) || (a as Account).label !== k) throw new Error(`Backup contains an invalid account "${k}"`);
  }
  replaceState({ accounts: data.accounts, credentials: data.credentials, settings: { disabledTools: [], ...(data.settings ?? {}) } });
  return Object.keys(data.accounts!).length;
}
