// Re-encrypt the state file with a new ENCRYPTION_KEY.
//   docker compose exec mcp node dist/cli/rotate-key.js            (prints a fresh key)
//   OLD/NEW can be given as env vars: OLD_ENCRYPTION_KEY (defaults to ENCRYPTION_KEY) and NEW_ENCRYPTION_KEY.
// Afterwards put the new key in .env and restart. The old file is kept as state.enc.bak-<time>.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { decryptWith, encryptWith } from "../crypto.js";

const toKey = (b64: string) => {
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("A key must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  return k;
};

export function rotateStateFile(file: string, oldKeyB64: string, newKeyB64: string): string {
  if (!existsSync(file)) throw new Error(`No state file at ${file}`);
  const plain = decryptWith(toKey(oldKeyB64), readFileSync(file)); // throws if the old key is wrong
  const backup = `${file}.bak-${Date.now()}`;
  copyFileSync(file, backup);
  writeFileSync(`${file}.tmp`, encryptWith(toKey(newKeyB64), plain), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return backup;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const file = join(process.env.DATA_DIR ?? "./data", "state.enc");
    const oldKey = process.env.OLD_ENCRYPTION_KEY ?? process.env.ENCRYPTION_KEY;
    if (!oldKey) throw new Error("Set ENCRYPTION_KEY (or OLD_ENCRYPTION_KEY) to the current key");
    const newKey = process.env.NEW_ENCRYPTION_KEY ?? randomBytes(32).toString("base64");
    const backup = rotateStateFile(file, oldKey, newKey);
    console.log(`Re-encrypted ${file}\nOld file kept as ${backup} (delete it once the new key works).\n\nNEW ENCRYPTION_KEY=${newKey}\n\nUpdate .env with this value and restart the server.`);
  } catch (e: any) {
    console.error(`Failed: ${e.message}`);
    process.exit(1);
  }
}
