import { NextResponse } from "next/server";

import { createPrismaAuditEventWriter } from "@/src/application/audit-event";
import { createClaimDraft } from "@/src/application/create-claim-draft";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { getSessionActorId } from "@/src/server/session";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actorId = getSessionActorId(request);
    const url = new URL(request.url);
    const query = url.searchParams.get("query")?.trim();
    const status = url.searchParams.get("status");
    const prisma = getPrisma();
    const claims = await prisma.claimDraft.findMany({
      where: {
        employeeId: actorId,
        ...(status && status !== "ALL" ? { status: status as "DRAFT" | "PROCESSING" | "NEEDS_INFORMATION" | "AWAITING_CONFIRMATION" | "SUBMITTED" } : {}),
        ...(query ? { purpose: { contains: query, mode: "insensitive" } } : {}),
      },
      include: { submissions: { select: { submissionNumber: true, submittedAt: true }, take: 1 }, expenseItems: { select: { amountCents: true } } },
      orderBy: { updatedAt: "desc" },
    });
    const items = claims.map((claim) => ({ id: claim.id, status: claim.status, purpose: claim.purpose, updatedAt: claim.updatedAt, totalAmountCents: claim.expenseItems.reduce((sum, item) => sum + item.amountCents, 0), submissionNumber: claim.submissions[0]?.submissionNumber ?? null, submittedAt: claim.submissions[0]?.submittedAt ?? null }));
    return NextResponse.json({ items, total: items.length });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actorId = getSessionActorId(request);
    const body = (await request.json()) as { purpose?: unknown };
    if (body.purpose !== undefined && typeof body.purpose !== "string") {
      return NextResponse.json({ error: "purpose must be a string" }, { status: 400 });
    }

    const prisma = getPrisma();
    const claim = await createClaimDraft(
      { actorId, purpose: body.purpose },
      { claims: new PrismaClaimRepository(prisma), audit: createPrismaAuditEventWriter(prisma) },
    );

    return NextResponse.json(
      { id: claim.id, status: claim.status, version: claim.version },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function getPrisma() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("database configuration is missing");
  return createPrismaClient(connectionString);
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "request failed";
  const status = message === "unauthenticated" ? 401 : 500;
  return NextResponse.json({ error: message }, { status });
}
