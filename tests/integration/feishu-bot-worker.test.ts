import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { processFeishuEvent } from "@/src/application/process-feishu-event";
import type { FeishuInboundMessage } from "@/src/domain/feishu-bot";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { FeishuBotRepository } from "@/src/infrastructure/prisma/feishu-bot-repository";
import type { FeishuBotClient } from "@/src/infrastructure/feishu/feishu-bot-client";
import { createFeishuBotRuntime } from "@/src/worker/feishu-bot-runtime";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  await prisma.inboundChannelEvent.deleteMany();
  await prisma.agentMessage.deleteMany();
  await prisma.reimbursementIntake.deleteMany();
  await prisma.agentConversation.deleteMany();
  await prisma.feishuConversation.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.submissionSnapshot.deleteMany();
  await prisma.claimDraft.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.employee.create({ data: { id: "employee-1", displayName: "测试员工", feishuUserId: "ou-employee" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

it("persists private and group scopes without creating a draft for a policy-only Feishu question", async () => {
  const messages = new Map<string, FeishuInboundMessage>([
    ["om-private", { messageId: "om-private", chatId: "oc-direct", chatType: "p2p", senderOpenId: "ou-employee", messageType: "text", text: "住宿规则", mentions: [], attachments: [] }],
    ["om-group", { messageId: "om-group", chatId: "oc-group", chatType: "group", senderOpenId: "ou-employee", messageType: "text", text: "@机器人 住宿规则", mentions: ["ou-bot"], attachments: [] }],
  ]);
  const replies: string[] = [];
  const { runtime, turns } = createRuntime(messages, replies);

  await runtime.onEvent(rawEvent("event-private", "om-private", "oc-direct", "p2p"));
  await expect(runtime.drainOnce()).resolves.toBe(true);
  await runtime.onEvent(rawEvent("event-group", "om-group", "oc-group", "group", ["ou-bot"]));
  await expect(runtime.drainOnce()).resolves.toBe(true);

  expect(await prisma.claimDraft.count()).toBe(0);
  expect(await prisma.agentConversation.findMany({ orderBy: { kind: "asc" } })).toEqual([
    expect.objectContaining({ employeeId: "employee-1", kind: "PRIVATE", scopeKey: "private" }),
    expect.objectContaining({ employeeId: "employee-1", kind: "GROUP", scopeKey: "oc-group" }),
  ]);
  expect(turns.map((turn) => turn.conversationId)).toHaveLength(2);
  expect(new Set(turns.map((turn) => turn.conversationId)).size).toBe(2);
  expect(replies).toHaveLength(2);
});

it("deduplicates a redelivered message before it reaches the conversation turn", async () => {
  const messages = new Map<string, FeishuInboundMessage>([
    ["om-first", { messageId: "om-first", chatId: "oc-direct", chatType: "p2p", senderOpenId: "ou-employee", messageType: "text", text: "政策", mentions: [], attachments: [] }],
  ]);
  const replies: string[] = [];
  const { runtime, turns } = createRuntime(messages, replies);

  await runtime.onEvent(rawEvent("event-first", "om-first", "oc-direct", "p2p"));
  await expect(runtime.drainOnce()).resolves.toBe(true);
  await runtime.onEvent(rawEvent("event-redelivered", "om-first", "oc-direct", "p2p"));
  await expect(runtime.drainOnce()).resolves.toBe(false);

  expect(turns).toHaveLength(1);
  expect(replies).toHaveLength(1);
});

function createRuntime(messages: Map<string, FeishuInboundMessage>, replies: string[]) {
  const repository = new FeishuBotRepository(prisma);
  const conversations = new AgentConversationRepository(prisma);
  const turns: Array<{ conversationId: string; channelMessageId: string }> = [];
  const client: FeishuBotClient = {
    async getMessage(messageId) {
      const message = messages.get(messageId);
      if (!message) throw new Error("message unavailable");
      return message;
    },
    async downloadResource() { throw new Error("attachment not used in this flow"); },
    async sendText() { throw new Error("proactive messages are not used"); },
    async replyText(_messageId, text) { replies.push(text); },
    async replyCard() { throw new Error("card replies are not used"); },
  };
  const process = (input: { eventId: string }) => processFeishuEvent(input, {
    botOpenId: "ou-bot",
    publicAppUrl: "https://reimbursement.example.test",
    events: repository,
    conversations,
    client,
    runConversationTurn: async (turn) => {
      turns.push({ conversationId: turn.conversationId, channelMessageId: turn.channelMessageId });
      return { reply: "根据制度，住宿费用上限为每晚 500 元。", citations: [], intake: null };
    },
  });
  return {
    turns,
    runtime: createFeishuBotRuntime({ repository, processEvent: process, replyText: client.replyText }),
  };
}

function rawEvent(eventId: string, messageId: string, chatId: string, chatType: "p2p" | "group", mentions: string[] = []) {
  return {
    event_id: eventId,
    sender: { sender_id: { open_id: "ou-employee" } },
    message: { message_id: messageId, message_type: "text", chat_id: chatId, chat_type: chatType, mentions: mentions.map((openId) => ({ id: { open_id: openId } })) },
  };
}
