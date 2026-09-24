import { NextResponse } from "next/server";

import type { Prisma } from "@/generated/prisma/client";
import { createPrismaAuditEventWriter } from "@/src/application/audit-event";
import { buildAgentContext } from "@/src/application/build-agent-context";
import { getClaimSummary } from "@/src/application/get-claim-summary";
import { runAgentTurn } from "@/src/application/run-agent-turn";
import { formatProposalValue, type AgentProposalField } from "@/src/domain/agent-proposal";
import { createChatModel } from "@/src/infrastructure/model/chat-model-factory";
import { ChatModelError } from "@/src/infrastructure/model/openai-compatible-chat-model";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { loadConfig } from "@/src/server/config";
import { getSessionActorId } from "@/src/server/session";
import { validateStoredClaim } from "@/src/server/stored-claim-validation";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ claimId: string }> }) {
  try {
    const actorId = getSessionActorId(request);
    const { claimId } = await context.params;
    const body = (await request.json()) as { message?: unknown };
    if (typeof body.message !== "string" || !body.message.trim() || body.message.trim().length > 2_000) return NextResponse.json({ error: "message is invalid" }, { status: 400 });
    const prisma = getPrisma();
    const claims = new PrismaClaimRepository(prisma);
    const result = await runAgentTurn(
      { actorId, claimId, message: body.message },
      {
        model: createChatModel(loadConfig(process.env)),
        getContext: async (actor, id) => {
          const summary = await getClaimSummary(actor, id, { claims });
          const draft = await prisma.claimDraft.findUnique({ where: { id }, include: { receipts: true, expenseItems: true, validationResults: true } });
          if (!draft) throw new Error("claim not found");
          const issues = validateStoredClaim(draft);
          return buildAgentContext({
            claim: { version: draft.version, purpose: draft.purpose, totalAmountCents: summary.totalAmountCents, expenseItems: draft.expenseItems, receipts: draft.receipts },
            issues,
          });
        },
        createProposal: async (proposal) => {
          const saved = await prisma.agentFieldProposal.create({
            data: {
              claimId: proposal.claimId,
              expenseItemId: proposal.expenseItemId,
              targetRef: proposal.target,
              field: proposal.field,
              value: proposal.value as Prisma.InputJsonValue,
              reason: proposal.reason,
              claimVersion: proposal.claimVersion,
            },
          });
          await createPrismaAuditEventWriter(prisma).append({ type: "AGENT_FIELD_PROPOSED", actorId: proposal.actorId, claimId: proposal.claimId, payload: { proposalId: saved.id, field: saved.field } });
          return { id: saved.id, target: saved.targetRef, field: saved.field, displayValue: formatProposalValue({ field: saved.field as AgentProposalField, value: saved.value as string | number }), reason: saved.reason, status: saved.status, claimVersion: saved.claimVersion };
        },
        audit: createPrismaAuditEventWriter(prisma),
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ChatModelError) return NextResponse.json({ error: error.message }, { status: 503 });
    const message = error instanceof Error ? error.message : "request failed";
    return NextResponse.json({ error: message }, { status: message === "unauthenticated" ? 401 : message === "forbidden" ? 403 : message === "claim not found" ? 404 : 500 });
  }
}

function getPrisma() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}
