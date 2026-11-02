import { NextResponse } from "next/server";

import { loadSsoBackchannelKeys, verifySsoBackchannelLogout } from "@/src/server/sso-backchannel";
import { createConfiguredSsoSessionService } from "@/src/server/sso-session-repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return NextResponse.json({ error: "invalid_logout_request" }, { status: 400 });
  }
  const body = await request.text();
  if (body.length > 16 * 1024) return NextResponse.json({ error: "invalid_logout_request" }, { status: 400 });
  const tokens = new URLSearchParams(body).getAll("logout_token");
  if (tokens.length !== 1 || !tokens[0]) return NextResponse.json({ error: "invalid_logout_request" }, { status: 400 });
  let keys;
  try {
    keys = await loadSsoBackchannelKeys();
  } catch {
    return NextResponse.json({ error: "sso_unavailable" }, { status: 503 });
  }
  let sid: string;
  try {
    sid = await verifySsoBackchannelLogout(tokens[0], keys);
  } catch {
    return NextResponse.json({ error: "invalid_logout_token" }, { status: 401 });
  }
  try {
    await createConfiguredSsoSessionService().deleteBySid(sid);
  } catch {
    return NextResponse.json({ error: "session_store_unavailable" }, { status: 503 });
  }
  return new NextResponse(null, { status: 204 });
}
