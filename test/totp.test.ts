import "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { base32Decode, base32Encode, hotp, newRecoveryCodes, useRecoveryCode, verifyTotp } from "../src/totp.ts";

// RFC 6238 appendix B, SHA-1 secret "12345678901234567890" (6-digit codes are the last 6 of the 8-digit vectors)
const SECRET = base32Encode(Buffer.from("12345678901234567890"));

test("base32 round trips", () => {
  assert.equal(SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(base32Decode(SECRET).toString(), "12345678901234567890");
});

test("matches the RFC 6238 test vectors", () => {
  assert.equal(hotp(SECRET, Math.floor(59 / 30)), "287082");
  assert.equal(hotp(SECRET, Math.floor(1111111109 / 30)), "081804");
  assert.equal(hotp(SECRET, Math.floor(1234567890 / 30)), "005924");
});

test("accepts the current and adjacent steps, rejects others and malformed input", () => {
  const now = 1234567890_000;
  assert.ok(verifyTotp(SECRET, "005924", 0, now));
  assert.ok(verifyTotp(SECRET, "005924", 0, now + 30_000)); // one step late
  assert.equal(verifyTotp(SECRET, "005924", 0, now + 120_000), null);
  assert.equal(verifyTotp(SECRET, "12345", 0, now), null);
  assert.equal(verifyTotp(SECRET, "abcdef", 0, now), null);
});

test("a code can only be used once", () => {
  const now = 1234567890_000;
  const step = verifyTotp(SECRET, "005924", 0, now)!;
  assert.equal(verifyTotp(SECRET, "005924", step, now), null);
});

test("recovery codes work once", () => {
  const { plain, hashed } = newRecoveryCodes(3);
  const rest = useRecoveryCode(hashed, plain[1].toUpperCase())!;
  assert.equal(rest.length, 2);
  assert.equal(useRecoveryCode(rest, plain[1]), null);
  assert.equal(useRecoveryCode(rest, "nope-nope"), null);
});
