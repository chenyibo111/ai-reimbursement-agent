import { NextResponse } from "next/server";

import { clearOAuthStateCookie, clearSessionCookie } from "@/src/server/auth-cookies";

export const runtime = "nodejs";

export async function POST() {
  const response = new NextResponse(null, { status: 204 });
  const isProduction = process.env.NODE_ENV === "production";
  response.headers.append("Set-Cookie", clearSessionCookie(isProduction));
  response.headers.append("Set-Cookie", clearOAuthStateCookie(isProduction));
  return response;
}
