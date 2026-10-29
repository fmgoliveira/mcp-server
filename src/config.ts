import { mkdirSync } from "node:fs";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  publicUrl: req("PUBLIC_URL").replace(/\/+$/, ""),
  adminPassword: req("ADMIN_PASSWORD"),
  encryptionKey: Buffer.from(req("ENCRYPTION_KEY"), "base64"),
  port: Number(process.env.PORT ?? 3000),
  dataDir: process.env.DATA_DIR ?? "./data",
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    scopes: (
      process.env.GOOGLE_SCOPES ??
      [
        "openid",
        "email",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/presentations",
        "https://www.googleapis.com/auth/forms.body",
        "https://www.googleapis.com/auth/forms.responses.readonly",
      ].join(" ")
    ).split(/\s+/),
  },
  microsoft: {
    clientId: process.env.MS_CLIENT_ID ?? "",
    clientSecret: process.env.MS_CLIENT_SECRET ?? "",
    scopes: (
      process.env.MS_SCOPES ??
      [
        "offline_access",
        "User.Read",
        "Mail.ReadWrite",
        "Mail.Send",
        "Calendars.ReadWrite",
        "Files.ReadWrite.All",
        "Sites.ReadWrite.All",
      ].join(" ")
    ).split(/\s+/),
  },
};

if (config.encryptionKey.length !== 32) {
  throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
}
mkdirSync(config.dataDir, { recursive: true });
