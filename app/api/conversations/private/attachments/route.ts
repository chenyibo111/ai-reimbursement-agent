import { NextResponse } from "next/server";
import { runConversationTurn, type ConversationStore } from "@/src/application/run-conversation-turn";
import { createAgentReimbursementRuntime } from "@/src/agent/reimbursement-runtime";
import { createChatModel } from "@/src/infrastructure/model/chat-model-factory";
import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { loadConfig } from "@/src/server/config";
import { ensureStoredEmployee } from "@/src/server/employee-identity";
import { getSessionActorId } from "@/src/server/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const actorId = getSessionActorId(request);
    const form = await request.formData();
    const file = form.get("file");
    const turnId = form.get("turnId");
    if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") return NextResponse.json({ error: "file is required" }, { status: 400 });
    if (typeof turnId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(turnId)) return NextResponse.json({ error: "turnId is invalid" }, { status: 400 });
    const prisma = getPrisma();
    const actor = await ensureStoredEmployee(actorId);
    if (!actor?.isActive) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    const tools = createAgentReimbursementRuntime(prisma);
    const repository = new AgentConversationRepository(prisma);
    const conversation = await repository.getOrCreatePrivate(actorId);
    const context = { actorId, actorRole: actor.role, channel: "WEB" as const, conversationId: conversation.id, turnId };
    const attachment = { filename: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
    const result = await runConversationTurn({ actorId, conversationId: conversation.id, channel: "WEB", channelMessageId: `web:${actorId}:${turnId}`, message: "上传票据", attachment }, {
      conversations: repository as unknown as ConversationStore,
      model: createChatModel(loadConfig(process.env)),
      preflightAttachment: async () => {},
      createClaim: ({ purpose }) => tools.createClaim(context, purpose),
      uploadReceipt: async (input) => { const receipt = await tools.uploadReceipt(context, input.claimId, { filename: input.filename, mimeType: input.mimeType, bytes: input.bytes }); return { id: receipt.receiptId }; },
      readWorkbench: ({ claimId }) => tools.readWorkbench(context, claimId),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    const status = message === "unauthenticated" ? 401 : message === "file is required" || message === "turnId is invalid" ? 400 : 503;
    return NextResponse.json({ error: status === 503 ? "报销服务暂不可用，请稍后重试。" : message }, { status });
  }
}

function getPrisma() {
  if (!process.env.DATABASE_URL) throw new Error("database configuration is missing");
  return createPrismaClient(process.env.DATABASE_URL);
}
