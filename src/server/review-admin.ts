import { NextResponse } from "next/server";

import type { EmployeeRoleName } from "@/src/domain/async-job";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { getSessionActorId } from "@/src/server/session";

export async function getReviewActor(request: Request) {
  const actorId = getSessionActorId(request);
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  const employee = await prisma.employee.findUnique({ where: { id: actorId }, select: { id: true, role: true } });
  if (!employee) throw new Error("forbidden");
  return { actor: { id: employee.id, role: employee.role as EmployeeRoleName }, prisma };
}

export function reviewFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "request failed";
  const status = message === "unauthenticated" ? 401
    : message === "forbidden" ? 403
      : message === "review not found" || message === "employee not found" ? 404
        : message === "review already claimed" || message === "review is not actionable" || message === "cannot remove the final administrator" || message === "version conflict" ? 409
          : message.startsWith("invalid ") ? 400
            : 500;
  return NextResponse.json({ error: message }, { status });
}
