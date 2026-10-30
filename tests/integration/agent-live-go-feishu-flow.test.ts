import { randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import { processFeishuEvent } from "@/src/application/process-feishu-event";
import { runConversationTurn, type ConversationStore } from "@/src/application/run-conversation-turn";
import { createAgentReimbursementRuntime } from "@/src/agent/reimbursement-runtime";
import type { FeishuInboundMessage } from "@/src/domain/feishu-bot";
import type { FeishuBotClient } from "@/src/infrastructure/feishu/feishu-bot-client";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { FeishuBotRepository } from "@/src/infrastructure/prisma/feishu-bot-repository";
import { createFeishuIdentityEnsurer } from "@/src/server/employee-identity";
import { createFeishuBotRuntime } from "@/src/worker/feishu-bot-runtime";

const goUrl = process.env.TEST_AGENT_GO_API_URL;
const databaseUrl = process.env.TEST_DATABASE_URL;

it.skipIf(!goUrl || !databaseUrl)("persists Feishu turns through the Go HTTP tool gateway and rejects foreign access", async () => {
  const suffix = randomUUID();
  const openId = `ou-agent-p0-${suffix}`;
  const otherOpenId = `ou-agent-p0-other-${suffix}`;
  const chatId = `oc-agent-p0-${suffix}`;
  const prisma = createPrismaClient(databaseUrl!);
  await prisma.$connect();
  try {
    const events = new FeishuBotRepository(prisma);
    const conversations = new AgentConversationRepository(prisma);
    const identity = createFeishuIdentityEnsurer(prisma, { ...process.env, REIMBURSEMENT_API_URL: goUrl });
    const tools = createAgentReimbursementRuntime(prisma, { ...process.env, REIMBURSEMENT_API_URL: goUrl }, fetch, "feishu-worker");
    const messages = new Map<string, FeishuInboundMessage>();
    const replies: Array<{ messageId: string; text: string }> = [];
    const client: FeishuBotClient = {
      async getMessage(messageId) {
        const found = messages.get(messageId);
        if (!found) throw new Error("missing controlled Feishu message");
        return found;
      },
      async downloadResource() { throw new Error("this scenario has no attachment"); },
      async sendText() { throw new Error("this scenario has no proactive notification"); },
      async replyText(messageId, text) { replies.push({ messageId, text }); },
      async replyCard() { throw new Error("this scenario has no card"); },
    };
    const runtime = createFeishuBotRuntime({
      repository: events,
      processEvent: (input) => processFeishuEvent(input, {
        botOpenId: "ou-agent-p0-bot",
        publicAppUrl: "http://localhost:8088",
        events,
        identities: { ensureEmployeeForInboundMessage: async ({ openId }) => {
          const employee = await identity({ openId });
          return { id: employee.id, role: employee.role };
        } },
        conversations,
        client,
        runConversationTurn: (turn) => {
          const context = { actorId: turn.actorId, actorRole: turn.actorRole, channel: "FEISHU" as const, conversationId: turn.conversationId, turnId: turn.channelMessageId };
          return runConversationTurn(turn, {
            conversations: conversations as unknown as ConversationStore,
            model: { decideConversation: async (modelContext) => {
              const text = modelContext.messages.find((message) => message.role === "USER")?.text;
              if (text === "开始报销") return { action: "START_INTAKE", reply: "开始" };
              if (text === "报销事由是客户拜访") return { action: "COLLECT_FIELDS", reply: "保存", fields: { purpose: "客户拜访" } };
              if (text === "查这张单据") return { action: "READ_CLAIM", reply: "查询" };
              if (text === "请提交这张报销单") return { action: "PREPARE_SUBMISSION", reply: "提交" };
              throw new Error("unexpected controlled model input");
            } },
            createClaim: ({ purpose }) => tools.createClaim(context, purpose),
            updateFields: ({ claimId, fields }) => tools.updateFields(context, claimId, fields),
            readWorkbench: ({ claimId }) => tools.readWorkbench(context, claimId),
            readValidation: ({ claimId }) => tools.readValidation(context, claimId),
            prepareSubmission: async ({ claimId }) => {
              const confirmation = await tools.prepareSubmission(context, claimId);
              return { token: confirmation.confirmationToken, claimId: confirmation.claimId, claimVersion: confirmation.claimVersion, workbench: confirmation.workbench };
            },
            findOwnedClaimByNumber: ({ claimNumber }) => tools.findOwnedClaimByNumber(context, claimNumber),
          });
        },
      }),
      replyText: (messageId, text, uuid) => client.replyText(messageId, text, uuid),
    });

    async function deliver(index: number, text: string) {
      const eventId = `agent-p0-event-${index}-${suffix}`;
      const messageId = `agent-p0-message-${index}-${suffix}`;
      messages.set(messageId, { messageId, chatId, chatType: "p2p", senderOpenId: openId, messageType: "text", text, mentions: [], attachments: [] });
      const event = { event_id: eventId, sender: { sender_id: { open_id: openId } }, message: { message_id: messageId, message_type: "text", chat_id: chatId, chat_type: "p2p" } } as const;
      await runtime.onEvent(event);
      for (let attempt = 0; attempt < 5 && await runtime.drainOnce(); attempt++) {}
      return event;
    }

    const firstEvent = await deliver(1, "新建报销");
    expect(replies.at(-1)?.text).toContain("已开始新的报销办理");
    await deliver(2, "报销事由是客户拜访");
    expect(replies.at(-1)?.text).toContain("已保存到报销草稿");
    const owner = await prisma.employee.findUniqueOrThrow({ where: { feishuUserId: openId } });
    const conversation = await conversations.getOrCreatePrivate(owner.id);
    const intake = await conversations.getCurrentIntake(owner.id);
    expect(intake?.claimId).toBeTruthy();
    const ownerContext = { actorId: owner.id, actorRole: "EMPLOYEE" as const, channel: "FEISHU" as const, conversationId: conversation.id, turnId: "verify-owner" };
    const workbench = await tools.readWorkbench(ownerContext, intake!.claimId!);
    expect(workbench.claim).toMatchObject({ id: intake!.claimId, purpose: "客户拜访", status: "DRAFT" });

    await deliver(3, "查这张单据");
    expect(replies.at(-1)?.text).toContain(workbench.claim.claimNumber);
    await deliver(4, "请提交这张报销单");
    expect(replies.at(-1)?.text).toContain("不能提交");
    expect((await tools.readWorkbench({ ...ownerContext, turnId: "verify-after-submit" }, intake!.claimId!)).claim.status).toBe("DRAFT");

    const other = await identity({ openId: otherOpenId });
    const foreign = await tools.findOwnedClaimByNumber({ actorId: other.id, actorRole: "EMPLOYEE", channel: "FEISHU", conversationId: "foreign-check", turnId: "foreign-check" }, workbench.claim.claimNumber);
    expect(foreign).toBeNull();
    await runtime.onEvent({ ...firstEvent, event_id: `agent-p0-redelivery-${suffix}` });
    for (let attempt = 0; attempt < 3 && await runtime.drainOnce(); attempt++) {}
    expect(replies).toHaveLength(4);
    expect(await prisma.agentMessage.count({ where: { conversationId: conversation.id } })).toBe(8);
    expect(await prisma.agentToolCall.count({ where: { conversationId: conversation.id, toolName: "create_claim_draft" } })).toBe(1);
    await runtime.stop();
  } finally {
    await prisma.$disconnect();
  }
});
