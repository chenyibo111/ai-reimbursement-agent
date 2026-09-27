import { NextResponse } from "next/server";

import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { isPolicyAdmin } from "@/src/server/authorization";
import { loadConfig } from "@/src/server/config";
import { toPolicySourceResponse } from "@/src/server/policy-source-response";
import { getSessionActorId } from "@/src/server/session";

export async function PATCH(request: Request, context: { params: Promise<{ sourceId: string }> }) {
  try {
    const { prisma } = await admin(request);
    const body = await request.json() as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") throw new Error("invalid policy source update");

    const { sourceId } = await context.params;
    const updated = await prisma.policySource.updateMany({ where: { id: sourceId }, data: { enabled: body.enabled } });
    if (!updated.count) throw new Error("policy source not found");
    const source = await prisma.policySource.findUniqueOrThrow({ where: { id: sourceId } });
    return NextResponse.json(toPolicySourceResponse(source));
  } catch (error) { return failure(error); }
}

async function admin(request: Request) {
  const actorId = getSessionActorId(request);
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  const employee = await prisma.employee.findUnique({ where: { id: actorId }, select: { id: true, feishuUserId: true } });
  if (!employee || !isPolicyAdmin(actorId, employee, loadConfig(process.env))) throw new Error("forbidden");
  return { prisma };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "request failed";
  const status = message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "policy source not found" ? 404 : message === "invalid policy source update" ? 400 : 500;
  return NextResponse.json({ error: message }, { status });
}
