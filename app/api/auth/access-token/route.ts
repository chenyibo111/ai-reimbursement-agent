import { NextResponse } from "next/server";

import { getSessionActorId } from "@/src/server/session";
import { ensureStoredEmployee } from "@/src/server/employee-identity";
import { createReimbursementJwt } from "@/src/server/reimbursement-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const employeeId = getSessionActorId(request);
    const employee = await ensureStoredEmployee(employeeId);
    if (!employee) return NextResponse.json({ code: "UNAUTHENTICATED", message: "请先登录后再操作" }, { status: 401 });
    const secret = process.env.REIMBURSEMENT_AUTH_HS256_SECRET;
    if (!secret) throw new Error("REIMBURSEMENT_AUTH_HS256_SECRET is required");
    const token = createReimbursementJwt({ subject: employee.id, role: employee.role, channel: "web" }, secret);
    return NextResponse.json({ accessToken: token, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), employee: { id: employee.id, displayName: employee.displayName, role: employee.role } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "unauthenticated") return NextResponse.json({ code: "UNAUTHENTICATED", message: "请先登录后再操作" }, { status: 401 });
    return NextResponse.json({ code: "IDENTITY_PROVISIONING_UNAVAILABLE", message: "身份初始化暂不可用，请稍后重试。" }, { status: 503 });
  }
}
