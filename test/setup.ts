// Imported first by every test file: gives config.ts the environment it requires, with a throwaway data directory.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

process.env.PUBLIC_URL = "https://mcp.test";
process.env.ADMIN_PASSWORD = "correct horse";
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "mcp-test-"));
