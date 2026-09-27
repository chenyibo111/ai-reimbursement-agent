import { NextResponse } from "next/server";

import { runConversationTurn, type ConversationStore } from "@/src/application/run-conversation-turn";
import { createPrismaAuditEventWriter } from "@/src/application/audit-event";
import { searchPolicyKnowledge } from "@/src/application/search-policy-knowledge";
import { requestStoredSubmission, submitStoredClaim } from "@/src/application/stored-submission";
import { updateClaimField } from "@/src/application/update-claim-field";
import { createEmbeddingProvider } from "@/src/infrastructure/embedding/embedding-provider-factory";
import { createChatModel } from "@/src/infrastructure/model/chat-model-factory";
import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { PrismaPolicyKnowledgeRepository } from "@/src/infrastructure/prisma/policy-knowledge-repository";
import { loadConfig } from "@/src/server/config";
import { getSessionActorId } from "@/src/server/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const actorId = getSessionActorId(request);
    const body = await request.json() as { message?: unknown };
    if (typeof body.message !== "string" || !body.message.trim() || body.message.trim().length > 2_000) {
      return NextResponse.json({ error: "message is invalid" }, { status: 400 });
    }
    const prisma = getPrisma();
    const repository = new AgentConversationRepository(prisma);
    const claims = new PrismaClaimRepository(prisma);
    const audit = createPrismaAuditEventWriter(prisma);
    const conversation = await repository.getOrCreatePrivate(actorId);
    const config = loadConfig(process.env);
    const result = await runConversationTurn(
      { actorId, conversationId: conversation.id, channel: "WEB", message: body.message },
      {
        conversations: repository as unknown as ConversationStore,
        model: createChatModel(config),
        searchPolicy: config.embedding ? (query) => searchPolicyKnowledge({ query, limit: 5 }, {
          embeddings: createEmbeddingProvider(config),
          chunks: new PrismaPolicyKnowledgeRepository(prisma),
        }) : undefined,
        updatePurpose: async ({ actorId: claimActorId, claimId, value }) => {
          const claim = await claims.getByIdOrThrow(claimId);
          const updated = await updateClaimField({ actorId: claimActorId, claimId, expectedVersion: claim.version, field: "purpose", value }, { claims, audit });
          return { version: updated.version };
        },
        requestSubmission: ({ actorId: submissionActorId, claimId }) => requestStoredSubmission({ prisma, actorId: submissionActorId, claimId }),
        submitClaim: async ({ actorId: submissionActorId, claimId, confirmationToken }) => {
          const submitted = await submitStoredClaim({ prisma, actorId: submissionActorId, claimId, confirmationToken });
          return { submissionNumber: submitted.submissionNumber };
        },
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

function getPrisma() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "request failed";
  const status = message === "unauthenticated" ? 401 : message === "message is invalid" || message === "no ready Intake" ? 400 : 500;
  return NextResponse.json({ error: message === "unauthenticated" || status === 400 ? message : "request failed" }, { status });
}
