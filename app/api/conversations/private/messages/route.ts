import { NextResponse } from "next/server";

import { runConversationTurn, type ConversationStore } from "@/src/application/run-conversation-turn";
import { requestStoredSubmission, submitStoredClaim } from "@/src/application/stored-submission";
import { createChatModel } from "@/src/infrastructure/model/chat-model-factory";
import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
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
    const conversation = await repository.getOrCreatePrivate(actorId);
    const result = await runConversationTurn(
      { actorId, conversationId: conversation.id, channel: "WEB", message: body.message },
      {
        conversations: repository as unknown as ConversationStore,
        model: createChatModel(loadConfig(process.env)),
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
