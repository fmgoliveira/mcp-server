// RFC 6238 time-based one-time passwords (SHA-1, 6 digits, 30 s) with no dependencies.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/[\s=]/g, "")) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(randomBytes(20));

export function hotp(secret: string, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}

export const stepOf = (now = Date.now()) => Math.floor(now / 1000 / 30);

/** Returns the matching time step, or null. Steps at or before `lastStep` are rejected so a code works once. */
export function verifyTotp(secret: string, input: string, lastStep = 0, now = Date.now()): number | null {
  const code = input.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const cur = stepOf(now);
  for (const step of [cur, cur - 1, cur + 1]) {
    if (step <= lastStep) continue;
    const want = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(want, Buffer.from(code))) return step;
  }
  return null;
}

export const otpauthUri = (secret: string, account: string, issuer: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---- recovery codes: shown once, stored as hashes, each usable once ----
const hashCode = (c: string) => createHash("sha256").update(c.replace(/[\s-]/g, "").toLowerCase()).digest("hex");

export function newRecoveryCodes(n = 8): { plain: string[]; hashed: string[] } {
  const plain = Array.from({ length: n }, () => {
    const h = randomBytes(5).toString("hex");
    return `${h.slice(0, 5)}-${h.slice(5)}`;
  });
  return { plain, hashed: plain.map(hashCode) };
}

/** Returns the remaining hashes if `input` was a valid unused recovery code, otherwise null. */
export function useRecoveryCode(hashes: string[], input: string): string[] | null {
  const h = hashCode(input);
  return hashes.includes(h) ? hashes.filter((x) => x !== h) : null;
}
