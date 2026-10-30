// Session handling and page helpers shared by the admin route files.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { Provider } from "./store.js";
import { errorGate, esc, META, shell, type NavKey } from "./ui.js";

const sign = (v: string) => createHmac("sha256", config.encryptionKey).update(v).digest("base64url");
const verify = (cookie: string | undefined, scope: string): boolean => {
  if (!cookie) return false;
  const [exp, sig] = cookie.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(scope + exp));
  return a.length === b.length && timingSafeEqual(a, b);
};
const cookieOf = (req: Request, name: string) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? "")?.[1];

const COOKIE = "HttpOnly; Secure; SameSite=Strict; Path=/admin";
function make(scope: string, ms: number): string {
  const exp = String(Date.now() + ms);
  return `${exp}.${sign(scope + exp)}`;
}

export const startSession = (res: Response) => res.setHeader("Set-Cookie", [`sess=${make("", 12 * 3600_000)}; ${COOKIE}; Max-Age=43200`, `pre=; ${COOKIE}; Max-Age=0`]);
export const endSession = (res: Response) => res.setHeader("Set-Cookie", [`sess=; ${COOKIE}; Max-Age=0`, `pre=; ${COOKIE}; Max-Age=0`]);
/** Password accepted, second step still to do. */
export const startPre = (res: Response) => res.setHeader("Set-Cookie", `pre=${make("pre", 5 * 60_000)}; ${COOKIE}; Max-Age=300`);
export const validPre = (req: Request) => verify(cookieOf(req, "pre"), "pre");
export const validSession = (req: Request) => verify(cookieOf(req, "sess"), "");

export const guard = (req: Request, res: Response, next: NextFunction) => (validSession(req) ? next() : res.redirect("/admin/login"));

export const PAT_CREDENTIAL = "pat"; // marks accounts connected with a pasted API token (no OAuth app)
export const ALL_PROVIDERS = Object.keys(META) as Provider[];
export const LABEL_PATTERN = "[a-zA-Z0-9_\\-]{1,32}";
export const LABEL_RE = /^[a-zA-Z0-9_-]{1,32}$/;
export const mcpUrl = `${config.publicUrl}/mcp`;

// Flash messages are looked up by key, so query parameters are never reflected into the page.
const FLASH: Record<string, string> = {
  removed: "Account removed.",
  "token-added": "Token verified and saved.",
  "app-saved": "OAuth app saved. You can connect an account with it now.",
  "app-removed": "OAuth app removed.",
  saved: "Changes saved.",
  tested: "Connection test finished.",
  "tested-all": "Connection tests finished.",
  revoked: "Client revoked. It has to be approved again to reconnect.",
  cleared: "Activity log cleared.",
  restored: "Backup restored.",
  "2fa-off": "Two-step sign-in is off.",
};
export const flash = (req: Request, error = "") => {
  const m = FLASH[String(req.query.msg ?? "")];
  return error ? `<p class="notice error" role=alert>${esc(error)}</p>` : m ? `<p class=notice role=status>${esc(m)}</p>` : "";
};

export const page = (res: Response, active: NavKey, title: string, body: string) => res.type("html").send(shell({ title, active, mcpUrl, body }));

export const fail = (res: Response, status: number, title: string, message: string, back = { href: "/admin", text: "Back to accounts" }) =>
  res.status(status).type("html").send(errorGate(title, message, back));

export const header = (title: string, lede: string, actions = "") =>
  `<div class=page-head><div><h1>${title}</h1><p class=lede>${lede}</p></div>${actions}</div>`;

export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toISOString().slice(0, 10);
}
