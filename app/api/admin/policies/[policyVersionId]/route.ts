import { NextResponse } from "next/server";

import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { isPolicyAdmin } from "@/src/server/authorization";
import { loadConfig } from "@/src/server/config";
import { getSessionActorId } from "@/src/server/session";

export async function GET(request: Request, context: { params: Promise<{ policyVersionId: string }> }) {
  try {
    const actorId = getSessionActorId(request);
    const prisma = db();
    const employee = await prisma.employee.findUnique({ where: { id: actorId }, select: { id: true, feishuUserId: true } });
    if (!employee || !isPolicyAdmin(actorId, employee, loadConfig(process.env))) throw new Error("forbidden");
    const { policyVersionId } = await context.params;
    const policy = await prisma.policyVersion.findUnique({ where: { id: policyVersionId }, include: { rules: { orderBy: { sortOrder: "asc" } } } });
    if (!policy) throw new Error("policy version not found");
    return NextResponse.json(policy);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return NextResponse.json({ error: message }, { status: message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "policy version not found" ? 404 : 500 });
  }
}

function db() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}
