import { NextResponse } from "next/server";

import type { EmployeeRoleName } from "@/src/domain/async-job";
import { getReviewActor, reviewFailure } from "@/src/server/review-admin";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ employeeId: string }> }) {
  try {
    const { employeeId } = await context.params;
    const { actor, prisma } = await getReviewActor(request);
    if (actor.role !== "ADMIN") throw new Error("forbidden");
    const body = await request.json() as { role?: unknown };
    if (!isRole(body.role)) throw new Error("invalid employee role");
    const nextRole = body.role;
    const updated = await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.findUnique({ where: { id: employeeId } });
      if (!employee) throw new Error("employee not found");
      if (employee.role === "ADMIN" && nextRole !== "ADMIN") {
        const admins = await tx.employee.count({ where: { role: "ADMIN" } });
        if (admins <= 1) throw new Error("cannot remove the final administrator");
      }
      return tx.employee.update({ where: { id: employeeId }, data: { role: nextRole } });
    }, { isolationLevel: "Serializable" });
    return NextResponse.json({ id: updated.id, role: updated.role });
  } catch (error) {
    return reviewFailure(error);
  }
}

function isRole(value: unknown): value is EmployeeRoleName {
  return value === "EMPLOYEE" || value === "FINANCE_REVIEWER" || value === "ADMIN";
}
