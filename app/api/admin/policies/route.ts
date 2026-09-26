import { NextResponse } from "next/server";

import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { PrismaPolicyRepository } from "@/src/infrastructure/prisma/policy-repository";
import { isPolicyAdmin } from "@/src/server/authorization";
import { loadConfig } from "@/src/server/config";
import { getSessionActorId } from "@/src/server/session";

export async function POST(request: Request) {
  try {
    const actorId = getSessionActorId(request);
    const body = await request.json() as { title?: unknown; effectiveFrom?: unknown };
    if (typeof body.title !== "string" || !body.title.trim() || typeof body.effectiveFrom !== "string" || Number.isNaN(Date.parse(body.effectiveFrom))) throw new Error("invalid policy draft");
    const prisma = getPrisma();
    const employee = await prisma.employee.findUnique({ where: { id: actorId }, select: { id: true, feishuUserId: true } });
    if (!employee || !isPolicyAdmin(actorId, employee, loadConfig(process.env))) throw new Error("forbidden");
    const draft = await new PrismaPolicyRepository(prisma).createDraft({ title: body.title, actorId, effectiveFrom: new Date(body.effectiveFrom) });
    return NextResponse.json(draft, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return NextResponse.json({ error: message }, { status: message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "invalid policy draft" ? 400 : 500 });
  }
}

function getPrisma() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}
