import { NextResponse } from "next/server";

import { createPrismaAuditEventWriter } from "@/src/application/audit-event";
import { getClaimSummary } from "@/src/application/get-claim-summary";
import { runAgentTurn } from "@/src/application/run-agent-turn";
import { validateClaimForActor } from "@/src/application/validate-claim";
import { FakeChatModel } from "@/src/infrastructure/model/fake-chat-model";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { getSessionActorId } from "@/src/server/session";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ claimId: string }> }) {
  try {
    const actorId = getSessionActorId(request);
    const { claimId } = await context.params;
    const body = (await request.json()) as { message?: unknown };
    if (typeof body.message !== "string" || !body.message.trim()) return NextResponse.json({ error: "message is required" }, { status: 400 });
    const prisma = getPrisma();
    const claims = new PrismaClaimRepository(prisma);
    const result = await runAgentTurn(
      { actorId, claimId, message: body.message },
      {
        model: new FakeChatModel(),
        getSummary: (actor, id) => getClaimSummary(actor, id, { claims }),
        validate: (actor, id) => validateClaimForActor(actor, id, { claims: { async getForValidation(targetId) { const claim = await prisma.claimDraft.findUnique({ where: { id: targetId }, include: { expenseItems: true } }); if (!claim) throw new Error("claim not found"); return { employeeId: claim.employeeId, status: claim.status, purpose: claim.purpose, expenseTotalCents: claim.expenseItems.reduce((sum, item) => sum + item.amountCents, 0), duplicate: false, fields: {} }; } } }),
        audit: createPrismaAuditEventWriter(prisma),
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return NextResponse.json({ error: message }, { status: message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "claim not found" ? 404 : 500 });
  }
}

function getPrisma() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}
