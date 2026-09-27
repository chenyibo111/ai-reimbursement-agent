import { NextResponse } from "next/server";

import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { getSessionActorId } from "@/src/server/session";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actorId = getSessionActorId(request);
    const repository = new AgentConversationRepository(getPrisma());
    const conversation = await repository.getOrCreatePrivate(actorId);
    const [messages, intake] = await Promise.all([
      repository.listMessages({ conversationId: conversation.id, limit: 50 }),
      repository.getCurrentIntake(actorId),
    ]);
    return NextResponse.json({
      conversation: { id: conversation.id, kind: conversation.kind, lastActiveAt: conversation.lastActiveAt },
      messages: messages.map(({ id, sequence, role, channel, text, citations, result, createdAt }) => ({ id, sequence, role, channel, text, citations, result, createdAt })),
      intake: intake?.conversationId === conversation.id ? intake : null,
    });
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
  return NextResponse.json({ error: message === "unauthenticated" ? message : "request failed" }, { status: message === "unauthenticated" ? 401 : 500 });
}
