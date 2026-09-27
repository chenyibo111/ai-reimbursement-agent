import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { createPrismaAuditEventWriter } from "@/src/application/audit-event";
import { createClaimDraft } from "@/src/application/create-claim-draft";
import { runConversationTurn, type ConversationStore } from "@/src/application/run-conversation-turn";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await prisma.$disconnect(); });

it("continues an Intake from Feishu in the employee private Web history while keeping group messages out", async () => {
  const employeeId = `cross-channel-${randomUUID()}`;
  await prisma.employee.create({ data: { id: employeeId, displayName: "跨渠道测试员工" } });
  const repository = new AgentConversationRepository(prisma);
  const conversations = repository as unknown as ConversationStore;
  const privateConversation = await repository.getOrCreatePrivate(employeeId);
  const groupConversation = await repository.getOrCreateGroup(employeeId, "oc-cross-channel-group");
  const channelMessageId = (suffix: string) => `${suffix}-${employeeId}`;
  const claims = new PrismaClaimRepository(prisma);
  const audit = createPrismaAuditEventWriter(prisma);
  const createClaim = async ({ actorId }: { actorId: string }) => createClaimDraft({ actorId }, { claims, audit });
  const uploadReceipt = async () => ({ id: "receipt-cross-channel" });
  let submitCalls = 0;
  const model = {
    classifyIntent: async () => "OTHER" as const,
    decideConversation: async () => ({ action: "REQUEST_SUBMISSION" as const, reply: "请确认提交。" }),
  };
  const deps = {
    conversations,
    model,
    createClaim,
    preflightAttachment: async () => undefined,
    uploadReceipt,
    requestSubmission: async ({ claimId }: { actorId: string; claimId: string }) => ({ token: "cross-channel-token", claimId }),
    submitClaim: async () => { submitCalls += 1; return { submissionNumber: "RB-CROSS-CHANNEL" }; },
    searchPolicy: async () => [{ id: "policy-group", title: "差旅制度", url: "https://example.test/policy", excerpt: "群聊也可回答制度问题。", headingPath: [], score: 0.9 }],
  };

  try {
    await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "FEISHU", channelMessageId: channelMessageId("om-cross-start"), message: "开始报销" }, deps);
    await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "WEB", message: "上传票据", attachment: { filename: "receipt.jpg", mimeType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff]) } }, deps);
    await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "WEB", message: "可以提交了吗" }, deps);
    const submitted = await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "FEISHU", channelMessageId: channelMessageId("om-cross-confirm"), message: "确认提交" }, deps);
    const replayed = await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "FEISHU", channelMessageId: channelMessageId("om-cross-confirm"), message: "确认提交" }, deps);
    await runConversationTurn({ actorId: employeeId, conversationId: groupConversation.id, channel: "FEISHU", channelMessageId: channelMessageId("om-group-policy"), message: "报销政策是什么" }, deps);

    expect(submitted).toMatchObject({ submissionNumber: "RB-CROSS-CHANNEL", intake: { status: "SUBMITTED", claimId: expect.any(String) } });
    expect(replayed).toMatchObject({ submissionNumber: "RB-CROSS-CHANNEL", intake: null });
    expect(submitCalls).toBe(1);
    const [privateMessages, groupMessages] = await Promise.all([
      repository.listMessages({ conversationId: privateConversation.id, limit: 50 }),
      repository.listMessages({ conversationId: groupConversation.id, limit: 50 }),
    ]);
    expect(privateMessages.some((message) => message.channel === "FEISHU" && message.text === "开始报销")).toBe(true);
    expect(privateMessages.some((message) => message.channel === "WEB" && message.text === "上传票据")).toBe(true);
    expect(privateMessages.some((message) => message.text === "报销政策是什么")).toBe(false);
    expect(groupMessages.some((message) => message.text === "报销政策是什么")).toBe(true);
  } finally {
    await prisma.claimDraft.deleteMany({ where: { employeeId } });
    await prisma.employee.delete({ where: { id: employeeId } });
  }
});
