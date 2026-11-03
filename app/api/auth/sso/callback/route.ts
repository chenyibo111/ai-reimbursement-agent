import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { ensureFeishuIdentity } from "@/src/server/employee-identity";
import { parseSafeReturnTo } from "@/src/server/reimbursement-auth";
import { completeSsoAuthorization, ssoRedirectUri } from "@/src/server/sso-oidc";
import { clearPending, pendingCookieNames, readPending } from "@/src/server/sso-oauth-cookies";
import { createConfiguredSsoSessionService, ssoSessionCookie } from "@/src/server/sso-session-repository";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = readPending(request, pendingCookieNames.state);
  const received = url.searchParams.get("state") ?? "";
  const nonce = readPending(request, pendingCookieNames.nonce);
  const verifier = readPending(request, pendingCookieNames.verifier);
  if (!state || !received || !same(received, state) || !nonce || !verifier || !url.searchParams.get("code")) {
    const response = NextResponse.json({ error: "invalid_sso_callback" }, { status: 400 });
    clearPending(response);
    return response;
  }
  let stage = "oidc_exchange";
  try {
    // Next may expose its container origin in request.url behind the edge.
    // The token request must use the exact redirect URI registered with Hydra.
    const registeredCallback = new URL(ssoRedirectUri());
    registeredCallback.search = url.search;
    const { idToken, identity } = await completeSsoAuthorization(registeredCallback, { state, nonce, verifier });
    stage = "employee_provisioning";
    const employee = await ensureFeishuIdentity({ openId: identity.openId, displayName: identity.displayName });
    stage = "session_persistence";
    const cookie = await createConfiguredSsoSessionService().create({ employeeId: employee.id, sid: identity.sid, idToken, expiresAt: identity.expiresAt });
    stage = "redirect";
    const destination = new URL(parseSafeReturnTo(readPending(request, pendingCookieNames.returnTo)), new URL(ssoRedirectUri()).origin);
    const response = NextResponse.redirect(destination);
    response.headers.append("Set-Cookie", ssoSessionCookie(cookie, Math.floor((identity.expiresAt.getTime() - Date.now()) / 1000)));
    clearPending(response);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
    console.error("[auth.sso.callback] failed", { stage, oauthError: typeof details.error === "string" ? details.error : undefined, status: details.status });
    const response = NextResponse.json({ error: "sso_login_failed" }, { status: 502 });
    clearPending(response);
    return response;
  }
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
