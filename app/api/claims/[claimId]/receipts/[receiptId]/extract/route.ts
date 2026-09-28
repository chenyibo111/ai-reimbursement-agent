import { NextResponse } from "next/server";

import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { PrismaAsyncJobRepository } from "@/src/infrastructure/prisma/async-job-repository";
import { getSessionActorId } from "@/src/server/session";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ claimId: string; receiptId: string }> }) {
  try {
    const actorId = getSessionActorId(request);
    const { claimId, receiptId } = await context.params;
    const prisma = getPrisma();
    const claim = await new PrismaClaimRepository(prisma).getByIdOrThrow(claimId);
    if (claim.employeeId !== actorId) throw new Error("forbidden");
    const receipt = await prisma.receipt.findFirst({ where: { id: receiptId, claimId }, select: { id: true } });
    if (!receipt) throw new Error("receipt not found");
    const job = await new PrismaAsyncJobRepository(prisma).enqueueJob({ kind: "RECEIPT_EXTRACTION", claimId, receiptId });
    return NextResponse.json({ receiptId, jobId: job.id, jobStatus: job.status }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    const status = message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "receipt not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

function getPrisma() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}
