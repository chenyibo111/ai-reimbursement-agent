import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { deliverReceiptExtractionNotificationOnce } from "@/src/application/deliver-receipt-extraction-notifications";
import { AgentConversationRepository } from "@/src/infrastructure/prisma/agent-conversation-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { ReceiptExtractionNotificationRepository } from "@/src/infrastructure/prisma/receipt-extraction-notification-repository";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => prisma.$connect());

beforeEach(async () => {
  await prisma.receiptExtractionNotification.deleteMany();
  await prisma.reviewCase.deleteMany();
  await prisma.asyncJob.deleteMany();
  await prisma.agentMessage.deleteMany();
  await prisma.reimbursementIntake.deleteMany();
  await prisma.agentConversation.deleteMany();
  await prisma.claimDraft.deleteMany({ where: { employeeId: "feishu-notification-employee" } });
  await prisma.employee.deleteMany({ where: { id: "feishu-notification-employee" } });
});

afterAll(async () => prisma.$disconnect());

it("delivers a low-confidence OCR result to the original Feishu conversation exactly once", async () => {
  const employee = await prisma.employee.create({ data: { id: "feishu-notification-employee", displayName: "飞书通知员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: employee.id } });
  const receipt = await prisma.receipt.create({
    data: {
      claimId: claim.id,
      objectKey: "claims/feishu-notification/receipt",
      contentHash: "feishu-notification-hash",
      mimeType: "image/png",
      status: "EXTRACTED",
      extractionPayload: {
        receiptType: "INVOICE",
        invoiceNumber: { value: "26317000", confidence: 0.4, source: "EXTRACTED" },
        issuedOn: { value: null, confidence: 0, source: "EXTRACTED" },
        totalAmountCents: { value: null, confidence: 0, source: "EXTRACTED" },
      },
    },
  });
  const conversation = await prisma.agentConversation.create({ data: { employeeId: employee.id, kind: "PRIVATE", scopeKey: "private" } });
  const job = await prisma.asyncJob.create({ data: { kind: "RECEIPT_EXTRACTION", status: "REVIEW_REQUIRED", failureCode: "OCR_LOW_CONFIDENCE", claimId: claim.id, receiptId: receipt.id } });
  const notifications = new ReceiptExtractionNotificationRepository(prisma);
  const notification = await notifications.createForFeishuUpload({ jobId: job.id, receiptId: receipt.id, claimId: claim.id, conversationId: conversation.id, chatId: "oc-original" });
  const sent: Array<{ chatId: string; text: string; uuid: string }> = [];
  const now = new Date("2099-09-28T11:00:00.000Z");
  const deps = {
    notifications,
    client: { sendText: async (chatId: string, text: string, uuid: string) => { sent.push({ chatId, text, uuid }); } },
    conversations: new AgentConversationRepository(prisma),
    publicAppUrl: "https://reimbursement.example.test",
    now: () => now,
    leaseMs: 60_000,
  };

  await expect(deliverReceiptExtractionNotificationOnce(deps)).resolves.toBe(true);
  await expect(deliverReceiptExtractionNotificationOnce(deps)).resolves.toBe(false);

  expect(sent).toEqual([expect.objectContaining({ chatId: "oc-original", uuid: notification.id, text: expect.stringContaining("发票号码：待确认识别值 26317000") })]);
  expect(sent[0]!.text).toContain("开票日期：请补充或确认");
  expect(sent[0]!.text).toContain("已转人工复核");
  await expect(prisma.receiptExtractionNotification.findUniqueOrThrow({ where: { id: notification.id } })).resolves.toMatchObject({ status: "SENT", sentAt: now });
  await expect(prisma.agentMessage.findUniqueOrThrow({ where: { channelMessageId: notification.id } })).resolves.toMatchObject({ conversationId: conversation.id, channel: "FEISHU", role: "ASSISTANT" });
});
