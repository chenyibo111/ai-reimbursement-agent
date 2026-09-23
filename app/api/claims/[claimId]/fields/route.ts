import { NextResponse } from "next/server";

import { createPrismaAuditEventWriter } from "@/src/application/audit-event";
import { updateClaimField } from "@/src/application/update-claim-field";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { getSessionActorId } from "@/src/server/session";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ claimId: string }> }) {
  try {
    const actorId = getSessionActorId(request);
    const { claimId } = await context.params;
    const body = (await request.json()) as { field?: unknown; value?: unknown; expectedVersion?: unknown };
    const { field, value, expectedVersion } = body;
    if (field !== "purpose" || typeof value !== "string" || typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion)) {
      return NextResponse.json({ error: "invalid field update" }, { status: 400 });
    }
    const prisma = getPrisma();
    const result = await updateClaimField(
      { actorId, claimId, field, value, expectedVersion },
      { claims: new PrismaClaimRepository(prisma), audit: createPrismaAuditEventWriter(prisma) },
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    const status = message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "version conflict" ? 409 : message === "purpose is required" ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

function getPrisma() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}
