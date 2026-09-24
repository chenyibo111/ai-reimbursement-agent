import { NextResponse } from "next/server";

import { getSessionActorId } from "@/src/server/session";

export function GET(request: Request) {
  try {
    return NextResponse.json({ employeeId: getSessionActorId(request) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return NextResponse.json({ error: message }, { status: message === "unauthenticated" ? 401 : 500 });
  }
}
