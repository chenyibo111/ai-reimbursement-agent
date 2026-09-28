import { NextResponse } from "next/server";

import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { PrismaPolicyRepository } from "@/src/infrastructure/prisma/policy-repository";
import { isPolicyAdmin } from "@/src/server/authorization";
import { loadConfig } from "@/src/server/config";
import { getSessionActorId } from "@/src/server/session";

export async function POST(request: Request, context: { params: Promise<{ policyVersionId: string }> }) {
  try {
    const actorId = getSessionActorId(request);
    const body = await request.json() as { expectedVersion?: unknown };
    const expectedVersion = body.expectedVersion;
    if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion)) throw new Error("invalid policy publish");
    const prisma = db();
    const employee = await prisma.employee.findUnique({ where: { id: actorId }, select: { id: true, feishuUserId: true, role: true } });
    if (!employee || !isPolicyAdmin(actorId, employee, loadConfig(process.env))) throw new Error("forbidden");
    const { policyVersionId } = await context.params;
    const policy = await new PrismaPolicyRepository(prisma).publish({
      policyVersionId,
      actorId,
      expectedVersion,
      now: new Date(),
    });
    return NextResponse.json(policy);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return NextResponse.json({ error: message }, {
      status: message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "invalid policy publish" ? 400 : message === "version conflict" || message === "policy version is not draft" ? 409 : 500,
    });
  }
}

function db() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}
