import { NextResponse } from "next/server";

import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { getSessionActorId } from "@/src/server/session";
import { validateStoredClaim } from "@/src/server/stored-claim-validation";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ claimId: string }> }) {
  try {
    const actorId = getSessionActorId(request);
    const { claimId } = await context.params;
    const prisma = getPrisma();
    const claim = await prisma.claimDraft.findUnique({ where: { id: claimId }, include: { receipts: { select: { extractionPayload: true } }, expenseItems: true, validationResults: { where: { code: { in: ["DUPLICATE_FILE", "DUPLICATE_INVOICE"] }, resolvedAt: null } } } });
    if (!claim) throw new Error("claim not found");
    if (claim.employeeId !== actorId) throw new Error("forbidden");
    const issues = validateStoredClaim(claim);
    return NextResponse.json({ issues });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return NextResponse.json({ error: message }, { status: message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "claim not found" ? 404 : 500 });
  }
}

function getPrisma() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}
