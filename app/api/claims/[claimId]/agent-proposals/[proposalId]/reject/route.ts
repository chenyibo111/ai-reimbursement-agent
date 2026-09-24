import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveAgentProposal } from "@/src/application/resolve-agent-proposal";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { getSessionActorId } from "@/src/server/session";

const bodySchema = z.object({ expectedVersion: z.number().int() }).strict();
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ claimId: string; proposalId: string }> }) {
  try {
    const actorId = getSessionActorId(request);
    const { claimId, proposalId } = await context.params;
    const body = bodySchema.safeParse(await request.json());
    if (!body.success) return NextResponse.json({ error: "invalid proposal resolution" }, { status: 400 });
    const result = await resolveAgentProposal({ actorId, claimId, proposalId, action: "REJECT", expectedVersion: body.data.expectedVersion }, { resolve: (input) => new PrismaClaimRepository(getPrisma()).resolveAgentProposal(input) });
    return NextResponse.json(result);
  } catch (error) { return errorResponse(error); }
}

function getPrisma() { if (!process.env.DATABASE_URL) throw new Error("database configuration is missing"); return createPrismaClient(process.env.DATABASE_URL); }
function errorResponse(error: unknown) { const message = error instanceof Error ? error.message : "request failed"; return NextResponse.json({ error: message }, { status: message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "claim not found" || message === "proposal not found" ? 404 : message === "version conflict" ? 409 : 500 }); }
