import { NextResponse } from "next/server";

import { parseSafeReturnTo } from "@/src/server/reimbursement-auth";
import { beginSsoAuthorization } from "@/src/server/sso-oidc";
import { pendingCookie, pendingCookieNames } from "@/src/server/sso-oauth-cookies";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const flow = await beginSsoAuthorization();
    const response = NextResponse.redirect(flow.url);
    response.headers.append("Set-Cookie", pendingCookie(pendingCookieNames.state, flow.state));
    response.headers.append("Set-Cookie", pendingCookie(pendingCookieNames.nonce, flow.nonce));
    response.headers.append("Set-Cookie", pendingCookie(pendingCookieNames.verifier, flow.verifier));
    response.headers.append("Set-Cookie", pendingCookie(pendingCookieNames.returnTo, parseSafeReturnTo(new URL(request.url).searchParams.get("returnTo"))));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return NextResponse.json({ error: "sso_unavailable" }, { status: 503 });
  }
}
