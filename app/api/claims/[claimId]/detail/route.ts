import { NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { getSessionActorId } from "@/src/server/session";

export async function GET(request: Request, context: { params: Promise<{ claimId: string }> }) {
  try {
    const actorId = getSessionActorId(request);
    const { claimId } = await context.params;
    const snapshot = await db().submissionSnapshot.findFirst({ where: { claimId }, include: { claim: { select: { employeeId: true, status: true } } } });
    if (!snapshot || snapshot.claim.status !== "SUBMITTED") throw new Error("submission not found");
    if (snapshot.claim.employeeId !== actorId) throw new Error("forbidden");
    const payload = snapshot.payload as Prisma.JsonObject;
    return NextResponse.json({ claimId, submissionNumber: snapshot.submissionNumber, submittedAt: snapshot.submittedAt, ...payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    const status = message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "submission not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

function db() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}
