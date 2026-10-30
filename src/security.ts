// Two-step sign-in state machine shared by the admin login and the Claude authorization page.
import qrcode from "qrcode-generator";
import { getState, save } from "./store.js";
import { newRecoveryCodes, newSecret, otpauthUri, useRecoveryCode, verifyTotp } from "./totp.js";

export const totpEnabled = () => !!getState().settings.totp;

/** Check a 6-digit code or a recovery code. A used TOTP step or recovery code can't be used again. */
export function checkSecondFactor(input: string): boolean {
  const t = getState().settings.totp;
  if (!t) return true;
  const step = verifyTotp(t.secret, input, t.lastStep);
  if (step !== null) {
    t.lastStep = step;
    save();
    return true;
  }
  const rest = useRecoveryCode(t.recovery, input);
  if (rest) {
    t.recovery = rest;
    save();
    return true;
  }
  return false;
}

export function beginTotpSetup(account: string): { secret: string; uri: string; qrSvg: string } {
  const s = getState().settings;
  s.totpPending = s.totpPending ?? newSecret();
  save();
  const uri = otpauthUri(s.totpPending, account, "Multi-account MCP");
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  return { secret: s.totpPending, uri, qrSvg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) };
}

/** Turns two-step sign-in on if `code` matches the pending secret. Returns the one-time recovery codes. */
export function confirmTotpSetup(code: string): string[] | null {
  const s = getState().settings;
  if (!s.totpPending) return null;
  const step = verifyTotp(s.totpPending, code);
  if (step === null) return null;
  const { plain, hashed } = newRecoveryCodes();
  s.totp = { secret: s.totpPending, recovery: hashed, lastStep: step };
  delete s.totpPending;
  save();
  return plain;
}

export function disableTotp(code: string): boolean {
  if (!checkSecondFactor(code)) return false;
  delete getState().settings.totp;
  delete getState().settings.totpPending;
  save();
  return true;
}

export const recoveryLeft = () => getState().settings.totp?.recovery.length ?? 0;
