import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { createPrismaAuditEventWriter } from "@/src/application/audit-event";
import { createClaimDraft } from "@/src/application/create-claim-draft";
import { processFeishuEvent } from "@/src/application/process-feishu-event";
import type { FeishuInboundMessage } from "@/src/domain/feishu-bot";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
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
  await prisma.feishuConversation.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.claimDraft.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.employee.create({ data: { id: "employee-1", displayName: "测试员工", feishuUserId: "ou-employee" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

it("persists, processes, and replies to a first bound message exactly once across message redelivery", async () => {
  const messages = new Map<string, FeishuInboundMessage>([
    ["om-first", { messageId: "om-first", chatId: "oc-direct", chatType: "p2p", senderOpenId: "ou-employee", messageType: "text", text: "客户午餐", mentions: [], attachments: [] }],
  ]);
  const replies: string[] = [];
  const { runtime, repository } = createRuntime(messages, replies);

  await runtime.onEvent(rawEvent("event-first", "om-first", "oc-direct", "p2p"));
  await expect(runtime.drainOnce()).resolves.toBe(true);

  const claims = await prisma.claimDraft.findMany({ where: { employeeId: "employee-1" } });
  expect(claims).toHaveLength(1);
  await expect(repository.getConversation("employee-1", "oc-direct")).resolves.toEqual({ claimId: claims[0].id });
  expect(replies).toEqual([expect.stringContaining(`/claims/${claims[0].id}`)]);

  await runtime.onEvent(rawEvent("event-redelivered", "om-first", "oc-direct", "p2p"));
  await expect(runtime.drainOnce()).resolves.toBe(false);
  await expect(prisma.claimDraft.count({ where: { employeeId: "employee-1" } })).resolves.toBe(1);
});

it("ignores a group message that has not mentioned the bot and routes new/view commands to the Web workspace", async () => {
  const messages = new Map<string, FeishuInboundMessage>([
    ["om-ignore", { messageId: "om-ignore", chatId: "oc-group", chatType: "group", senderOpenId: "ou-employee", messageType: "text", text: "报销", mentions: ["ou-other"], attachments: [] }],
    ["om-new", { messageId: "om-new", chatId: "oc-group", chatType: "group", senderOpenId: "ou-employee", messageType: "text", text: "新建报销", mentions: ["ou-bot"], attachments: [] }],
    ["om-view", { messageId: "om-view", chatId: "oc-group", chatType: "group", senderOpenId: "ou-employee", messageType: "text", text: "查看当前草稿", mentions: ["ou-bot"], attachments: [] }],
  ]);
  const replies: string[] = [];
  const { runtime } = createRuntime(messages, replies);

  await runtime.onEvent(rawEvent("event-ignore", "om-ignore", "oc-group", "group", ["ou-other"]));
  await runtime.drainOnce();
  await expect(prisma.claimDraft.count()).resolves.toBe(0);

  await runtime.onEvent(rawEvent("event-new", "om-new", "oc-group", "group", ["ou-bot"]));
  await runtime.drainOnce();
  const claim = await prisma.claimDraft.findFirstOrThrow();
  await runtime.onEvent(rawEvent("event-view", "om-view", "oc-group", "group", ["ou-bot"]));
  await runtime.drainOnce();

  expect(replies).toEqual([
    expect.stringContaining(`/claims/${claim.id}`),
    expect.stringContaining(`/claims/${claim.id}`),
  ]);
  expect(replies.join("\n")).not.toContain("提交");
  expect(replies.join("\n")).not.toContain("接受并写入");
});

function createRuntime(messages: Map<string, FeishuInboundMessage>, replies: string[]) {
  const repository = new FeishuBotRepository(prisma);
  const claims = new PrismaClaimRepository(prisma);
  const client: FeishuBotClient = {
    async getMessage(messageId) {
      const message = messages.get(messageId);
      if (!message) throw new Error("message unavailable");
      return message;
    },
    async downloadResource() { throw new Error("attachment not used in this flow"); },
    async replyText(_messageId, text) { replies.push(text); },
    async replyCard() { throw new Error("card replies are not used"); },
  };
  const process = (input: { eventId: string }) => processFeishuEvent(input, {
    botOpenId: "ou-bot",
    publicAppUrl: "https://reimbursement.example.test",
    events: repository,
    client,
    createClaimDraft: (claimInput) => createClaimDraft(claimInput, { claims, audit: createPrismaAuditEventWriter(prisma) }),
    runAgentTurn: async () => ({ reply: "请补充参与人员。", clarifications: [], proposals: [] }),
    uploadReceipt: async () => { throw new Error("attachment not used in this flow"); },
    extractReceipt: async () => { throw new Error("attachment not used in this flow"); },
  });
  return {
    repository,
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
