import { NextResponse } from "next/server";

import { runConversationTurn, type ConversationStore } from "@/src/application/run-conversation-turn";
import { createAgentReimbursementRuntime } from "@/src/agent/reimbursement-runtime";
import { searchPolicyKnowledge } from "@/src/application/search-policy-knowledge";
import { createEmbeddingProvider } from "@/src/infrastructure/embedding/embedding-provider-factory";
import { createChatModel } from "@/src/infrastructure/model/chat-model-factory";
import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { PrismaPolicyKnowledgeRepository } from "@/src/infrastructure/prisma/policy-knowledge-repository";
import { loadConfig } from "@/src/server/config";
import { ensureStoredEmployee } from "@/src/server/employee-identity";
import { getSessionActorId } from "@/src/server/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const actorId = getSessionActorId(request);
    const body = await request.json() as { message?: unknown; turnId?: unknown };
    if (typeof body.message !== "string" || !body.message.trim() || body.message.trim().length > 2_000) {
      return NextResponse.json({ error: "message is invalid" }, { status: 400 });
    }
    if (typeof body.turnId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.turnId)) return NextResponse.json({ error: "turnId is invalid" }, { status: 400 });
    const prisma = getPrisma();
    const actor = await ensureStoredEmployee(actorId);
    if (!actor?.isActive) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    const tools = createAgentReimbursementRuntime(prisma);
    const repository = new AgentConversationRepository(prisma);
    const conversation = await repository.getOrCreatePrivate(actorId);
    const context = { actorId, actorRole: actor.role, channel: "WEB" as const, conversationId: conversation.id, turnId: body.turnId };
    const config = loadConfig(process.env);
    const result = await runConversationTurn(
      { actorId, conversationId: conversation.id, channel: "WEB", channelMessageId: `web:${actorId}:${body.turnId}`, message: body.message },
      {
        conversations: repository as unknown as ConversationStore,
        model: createChatModel(config),
        searchPolicy: config.embedding ? (query) => searchPolicyKnowledge({ query, limit: 5 }, {
          embeddings: createEmbeddingProvider(config),
          chunks: new PrismaPolicyKnowledgeRepository(prisma),
        }) : undefined,
        createClaim: ({ purpose }) => tools.createClaim(context, purpose),
        updateFields: ({ claimId, fields }) => tools.updateFields(context, claimId, fields),
        readWorkbench: ({ claimId }) => tools.readWorkbench(context, claimId),
        deleteReceipt: ({ claimId, receiptId, expectedClaimVersion }) => tools.deleteReceipt(context, claimId, receiptId, expectedClaimVersion),
        deleteDraft: ({ claimId, expectedClaimVersion }) => tools.deleteDraft(context, claimId, expectedClaimVersion),
        listOwnedClaims: ({ limit }) => tools.listOwnedClaims(context, limit),
        searchOwnedClaims: ({ query }) => tools.searchOwnedClaims(context, query),
        findOwnedClaimByNumber: ({ claimNumber }) => tools.findOwnedClaimByNumber(context, claimNumber),
        readValidation: ({ claimId }) => tools.readValidation(context, claimId),
        readProgress: ({ claimId }) => tools.readProgress(context, claimId),
        prepareSubmission: async ({ claimId }) => { const confirmation = await tools.prepareSubmission(context, claimId); return { token: confirmation.confirmationToken, claimId: confirmation.claimId, claimVersion: confirmation.claimVersion, workbench: confirmation.workbench }; },
        submitClaim: async ({ claimId, confirmationToken }) => { const submitted = await tools.submit(context, claimId, confirmationToken); return { submissionNumber: submitted.submissionNumber }; },
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
  const status = message === "unauthenticated" ? 401 : message === "message is invalid" || message === "no ready Intake" ? 400 : 503;
  return NextResponse.json({ error: status === 503 ? "报销服务暂不可用，请稍后重试。" : message }, { status });
}
