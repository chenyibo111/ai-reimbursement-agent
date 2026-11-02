import { NextResponse } from "next/server";

import { getActiveSsoWebSession } from "@/src/server/sso-session-repository";
import { SsoSessionError } from "@/src/server/sso-web-session";
import { ensureStoredEmployee } from "@/src/server/employee-identity";
import { createReimbursementJwt } from "@/src/server/reimbursement-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  let stage = "session";
  try {
    const session = await getActiveSsoWebSession(request);
    stage = "employee_identity";
    const employee = await ensureStoredEmployee(session.employeeId);
    if (!employee) return NextResponse.json({ code: "UNAUTHENTICATED", message: "请先登录后再操作" }, { status: 401 });
    stage = "token_issuance";
    const secret = process.env.REIMBURSEMENT_AUTH_HS256_SECRET;
    if (!secret) throw new Error("REIMBURSEMENT_AUTH_HS256_SECRET is required");
    const token = createReimbursementJwt({ subject: employee.id, role: employee.role, channel: "web", sid: session.sid }, secret);
    return NextResponse.json({ accessToken: token, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), employee: { id: employee.id, displayName: employee.displayName, role: employee.role } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if ((error instanceof SsoSessionError && error.code === "UNAUTHENTICATED") || (error instanceof Error && error.message === "unauthenticated")) return NextResponse.json({ code: "UNAUTHENTICATED", message: "请先登录后再操作" }, { status: 401 });
    console.error("[auth.access-token] failed", {
      stage,
      error: error instanceof Error ? error.message : "unknown error",
    });
    return NextResponse.json({ code: "IDENTITY_PROVISIONING_UNAVAILABLE", message: "身份初始化暂不可用，请稍后重试。" }, { status: 503 });
  }
}
