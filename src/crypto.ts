// Pure encryption helpers (no config, no I/O) so they can be used by the server, the CLI and the tests.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/** AES-256-GCM. Layout: 12-byte IV | 16-byte tag | ciphertext. */
export function encryptWith(key: Buffer, plain: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

export function decryptWith(key: Buffer, buf: Buffer): string {
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

const BACKUP_MAGIC = "mamcp1";

/** Passphrase-protected backup, so it can be restored on an instance that uses a different ENCRYPTION_KEY. */
export function sealBackup(passphrase: string, plain: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32);
  return `${BACKUP_MAGIC}.${Buffer.concat([salt, encryptWith(key, plain)]).toString("base64url")}`;
}

export function openBackup(passphrase: string, sealed: string): string {
  const [magic, body] = sealed.trim().split(".");
  if (magic !== BACKUP_MAGIC || !body) throw new Error("This is not a backup file from this app");
  const raw = Buffer.from(body, "base64url");
  try {
    return decryptWith(scryptSync(passphrase, raw.subarray(0, 16), 32), raw.subarray(16));
  } catch {
    throw new Error("Wrong passphrase, or the backup is damaged");
  }
}
