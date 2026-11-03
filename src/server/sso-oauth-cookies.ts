import { getCookie } from "@/src/server/auth-cookies";
import { ssoRedirectUri } from "@/src/server/sso-oidc";

export const pendingCookieNames = {
  state: "sso_oauth_state",
  nonce: "sso_oauth_nonce",
  verifier: "sso_oauth_verifier",
  returnTo: "sso_oauth_return_to",
} as const;

export function pendingCookie(name: string, value: string, maxAge = 600): string {
  const secure = new URL(ssoRedirectUri()).protocol === "https:";
  return `${name}=${encodeURIComponent(value)}; Path=/api/auth/sso; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function readPending(request: Request, name: string): string {
  try {
    return decodeURIComponent(getCookie(request, name) ?? "");
  } catch {
    return "";
  }
}

export function clearPending(response: Response): void {
  for (const name of Object.values(pendingCookieNames)) response.headers.append("Set-Cookie", pendingCookie(name, "", 0));
}
