import { NextResponse } from "next/server";

import { getCookie } from "@/src/server/auth-cookies";
import { ssoLogoutUrl, ssoPostLogoutUri } from "@/src/server/sso-oidc";
import { SsoSessionError } from "@/src/server/sso-web-session";
import { clearSsoSessionCookie, createConfiguredSsoSessionService, ssoSessionCookieName } from "@/src/server/sso-session-repository";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const cookie = getCookie(request, ssoSessionCookieName);
  if (!cookie) return NextResponse.redirect(ssoPostLogoutUri());
  try {
    const service = createConfiguredSsoSessionService();
    const session = await service.active(cookie);
    const target = await ssoLogoutUrl(session.idToken);
    await service.deleteBySid(session.sid);
    const response = NextResponse.redirect(target);
    response.headers.append("Set-Cookie", clearSsoSessionCookie());
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof SsoSessionError && error.code === "UNAUTHENTICATED") {
      const response = NextResponse.redirect(ssoPostLogoutUri());
      response.headers.append("Set-Cookie", clearSsoSessionCookie());
      return response;
    }
    return NextResponse.json({ error: "sso_logout_unavailable" }, { status: 503 });
  }
}
