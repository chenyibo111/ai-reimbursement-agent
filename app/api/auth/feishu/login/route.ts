import { NextResponse } from "next/server";

import { createOAuthState, oauthStateCookie } from "@/src/server/auth-cookies";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const appId = process.env.FEISHU_APP_ID;
  const redirectUri = process.env.FEISHU_REDIRECT_URI;
  if (!appId || !redirectUri) {
    return NextResponse.json({ error: "feishu oauth is not configured" }, { status: 503 });
  }

  const state = createOAuthState();
  const authorizeUrl = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  authorizeUrl.searchParams.set("client_id", appId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "contact:user.base:readonly");
  authorizeUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(authorizeUrl);
  response.headers.append("Set-Cookie", oauthStateCookie(state, isProduction()));
  return response;
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}
