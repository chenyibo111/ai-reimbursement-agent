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
    decideConversation: async (context: { messages: Array<{ text: string }> }) => ({ action: context.messages[0]?.text === "开始报销" ? "START_INTAKE" as const : context.messages[0]?.text === "报销政策是什么" ? "POLICY_QUERY" as const : "PREPARE_SUBMISSION" as const, reply: "只分类" }),
  };
  const deps = {
    conversations,
    model,
    createClaim,
    preflightAttachment: async () => undefined,
    uploadReceipt,
    readValidation: async ({ claimId }: { actorId: string; claimId: string }) => ({ claimId, claimVersion: 1, policyVersion: "p1", issues: [] }),
    readWorkbench: async ({ claimId }: { actorId: string; claimId: string }) => ({ claim: { id: claimId, claimNumber: "BX-CROSS", version: 1, status: "DRAFT", purpose: "出差", requestedAmountCent: 10000, totalAmountCent: 10000, currency: "CNY" as const, receiptCount: 1 }, receipts: [{ id: "receipt-cross-channel", claimId, filename: "receipt.jpg", status: "EXTRACTED", invoiceNumber: "123", ocrConfidence: 0.9, totalAmountCent: 10000 }] }),
    prepareSubmission: async ({ claimId }: { actorId: string; claimId: string }) => ({ token: "cross-channel-token", claimId, claimVersion: 1, workbench: { claim: { id: claimId, claimNumber: "BX-CROSS", version: 1, status: "DRAFT", purpose: "出差", requestedAmountCent: 10000, totalAmountCent: 10000, currency: "CNY" as const, receiptCount: 1 }, receipts: [{ id: "receipt-cross-channel", claimId, filename: "receipt.jpg", status: "EXTRACTED", invoiceNumber: "123", ocrConfidence: 0.9, totalAmountCent: 10000 }] } }),
    submitClaim: async () => { submitCalls += 1; return { submissionNumber: "RB-CROSS-CHANNEL" }; },
    searchPolicy: async () => ({ citations: [{ id: "policy-group", title: "差旅制度", url: "https://example.test/policy", excerpt: "群聊也可回答制度问题。", headingPath: [], score: 0.9 }], evidence: [{ sectionId: "s1", title: "差旅制度", headingPath: [], text: "群聊也可回答制度问题。", complete: true }], incomplete: false }),
  };

  try {
    await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "FEISHU", chatType: "p2p", channelMessageId: channelMessageId("om-cross-start"), message: "开始报销" }, deps);
    await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "WEB", message: "上传票据", attachment: { filename: "receipt.jpg", mimeType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff]) } }, deps);
    await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "WEB", message: "可以提交了吗" }, deps);
    const submitted = await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "FEISHU", chatType: "p2p", channelMessageId: channelMessageId("om-cross-confirm"), message: "确认提交" }, deps);
    const replayed = await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "FEISHU", chatType: "p2p", channelMessageId: channelMessageId("om-cross-confirm"), message: "确认提交" }, deps);
    await runConversationTurn({ actorId: employeeId, conversationId: groupConversation.id, channel: "FEISHU", chatType: "group", channelMessageId: channelMessageId("om-group-policy"), message: "报销政策是什么" }, deps);

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

it("keeps policy and claim reads consistent across private Web and Feishu while blocking group reads and near-confirmations", async () => {
  const employeeId = `cross-channel-${randomUUID()}`;
  await prisma.employee.create({ data: { id: employeeId, displayName: "跨渠道测试员工" } });
  const repository = new AgentConversationRepository(prisma);
  const privateConversation = await repository.getOrCreatePrivate(employeeId);
  const groupConversation = await repository.getOrCreateGroup(employeeId, "oc-private-facts-test");
  await repository.createIntake({ employeeId, conversationId: privateConversation.id, claimId: "go-claim-parity", pendingFields: [] });
  let policySearches = 0;
  let claimReads = 0;
  let submissions = 0;
  const deps = {
    conversations: repository as unknown as ConversationStore,
    model: {
      decideConversation: async (context: { messages: Array<{ text: string }> }) => ({
        action: context.messages[0]?.text === "住宿报销规则是什么" ? "POLICY_QUERY" as const
          : context.messages[0]?.text === "这笔报销单目前怎样" ? "READ_CLAIM" as const
            : "HELP" as const,
        reply: "只分类",
      }),
      answerPolicy: async () => "住宿上限为 500 元。",
    },
    searchPolicy: async () => {
      policySearches += 1;
      return { citations: [{ id: "policy-parity", title: "差旅制度", url: "https://example.test/policy", excerpt: "住宿上限 500 元。", headingPath: ["住宿"], score: 0.9 }], evidence: [{ sectionId: "s1", title: "差旅制度", headingPath: ["住宿"], text: "住宿上限 500 元。", complete: true }], incomplete: false };
    },
    readWorkbench: async () => {
      claimReads += 1;
      return { claim: { id: "go-claim-parity", claimNumber: "BX-PARITY", version: 1, status: "DRAFT", purpose: "客户拜访", requestedAmountCent: 12345, totalAmountCent: 12345, currency: "CNY" as const, receiptCount: 0 }, receipts: [] };
    },
    submitClaim: async () => { submissions += 1; return { submissionNumber: "SHOULD-NOT-SUBMIT" }; },
  };

  try {
    const webPolicy = await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "WEB", message: "住宿报销规则是什么" }, deps);
    const feishuPolicy = await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "FEISHU", chatType: "p2p", message: "住宿报销规则是什么" }, deps);
    expect(webPolicy.reply).toBe(feishuPolicy.reply);
    expect(webPolicy.citations).toEqual(feishuPolicy.citations);
    expect(policySearches).toBe(2);

    const webClaim = await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "WEB", message: "这笔报销单目前怎样" }, deps);
    const feishuClaim = await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "FEISHU", chatType: "p2p", message: "这笔报销单目前怎样" }, deps);
    expect(webClaim.reply).toBe(feishuClaim.reply);
    expect(webClaim.reply).toContain("BX-PARITY");
    expect(claimReads).toBe(2);

    const groupClaim = await runConversationTurn({ actorId: employeeId, conversationId: groupConversation.id, channel: "FEISHU", chatType: "group", message: "这笔报销单目前怎样" }, deps);
    expect(groupClaim.reply).toContain("私聊机器人");
    expect(claimReads).toBe(2);
    const nearConfirmation = await runConversationTurn({ actorId: employeeId, conversationId: privateConversation.id, channel: "FEISHU", chatType: "p2p", message: "请确认提交" }, deps);
    expect(nearConfirmation.reply).not.toContain("SHOULD-NOT-SUBMIT");
    expect(submissions).toBe(0);
  } finally {
    await prisma.employee.delete({ where: { id: employeeId } });
  }
});
