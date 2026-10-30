import "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { decryptWith, encryptWith, openBackup, sealBackup } from "../src/crypto.ts";
import { rotateStateFile } from "../src/cli/rotate-key.ts";

test("encrypt/decrypt round trip, and tampering is detected", () => {
  const key = randomBytes(32);
  const blob = encryptWith(key, "secret state");
  assert.equal(decryptWith(key, blob), "secret state");
  blob[blob.length - 1] ^= 1;
  assert.throws(() => decryptWith(key, blob));
  assert.throws(() => decryptWith(randomBytes(32), encryptWith(key, "x")));
});

test("backups need the right passphrase", () => {
  const sealed = sealBackup("passphrase one", '{"a":1}');
  assert.equal(openBackup("passphrase one", sealed), '{"a":1}');
  assert.throws(() => openBackup("passphrase two", sealed), /Wrong passphrase/);
  assert.throws(() => openBackup("x", "garbage"), /not a backup/);
});

test("key rotation re-encrypts the state file and keeps a backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "rot-"));
  const file = join(dir, "state.enc");
  const oldKey = randomBytes(32), newKey = randomBytes(32);
  writeFileSync(file, encryptWith(oldKey, '{"accounts":{}}'));
  const backup = rotateStateFile(file, oldKey.toString("base64"), newKey.toString("base64"));
  assert.equal(decryptWith(newKey, readFileSync(file)), '{"accounts":{}}');
  assert.equal(decryptWith(oldKey, readFileSync(backup)), '{"accounts":{}}');
  assert.ok(readdirSync(dir).some((f) => f.startsWith("state.enc.bak-")));
  assert.throws(() => decryptWith(oldKey, readFileSync(file)));
});

test("rotation refuses a wrong old key and leaves the file alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "rot-"));
  const file = join(dir, "state.enc");
  const key = randomBytes(32);
  writeFileSync(file, encryptWith(key, "x"));
  const before = readFileSync(file);
  assert.throws(() => rotateStateFile(file, randomBytes(32).toString("base64"), randomBytes(32).toString("base64")));
  assert.deepEqual(readFileSync(file), before);
  assert.throws(() => rotateStateFile(file, key.toString("base64"), "short"), /32 bytes/);
});
