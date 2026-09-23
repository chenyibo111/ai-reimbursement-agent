import { randomBytes } from "node:crypto";
import { createSessionToken } from "@/src/server/session";

export const sessionCookieName = "reimbursement_session";
export const oauthStateCookieName = "reimbursement_oauth_state";

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionCookie(actorId: string, secret: string, isProduction: boolean): string {
  return cookie(sessionCookieName, createSessionToken(actorId, secret), isProduction, 60 * 60 * 8);
}

export function clearSessionCookie(isProduction: boolean): string {
  return cookie(sessionCookieName, "", isProduction, 0);
}

export function oauthStateCookie(value: string, isProduction: boolean): string {
  return cookie(oauthStateCookieName, value, isProduction, 10 * 60);
}

export function clearOAuthStateCookie(isProduction: boolean): string {
  return cookie(oauthStateCookieName, "", isProduction, 0);
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const entry of header.split(";")) {
    const [key, ...value] = entry.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

function cookie(name: string, value: string, isProduction: boolean, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isProduction ? "; Secure" : ""}`;
}
