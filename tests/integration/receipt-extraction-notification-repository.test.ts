import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { ReceiptExtractionNotificationRepository } from "@/src/infrastructure/prisma/receipt-extraction-notification-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";

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
  await prisma.claimDraft.deleteMany({ where: { employeeId: "notification-employee" } });
  await prisma.employee.deleteMany({ where: { id: "notification-employee" } });
});

afterAll(async () => prisma.$disconnect());

it("creates one deliverable notification per terminal OCR job and leases it to one worker", async () => {
  const target = await createTarget("SUCCEEDED");
  const repository = new ReceiptExtractionNotificationRepository(prisma);

  const created = await Promise.all([
    repository.createForFeishuUpload({ ...target, conversationId: target.conversationId, chatId: "oc-notification" }),
    repository.createForFeishuUpload({ ...target, conversationId: target.conversationId, chatId: "oc-notification" }),
  ]);

  expect(new Set(created.map((item) => item.id))).toHaveLength(1);
  expect(await repository.claimNextDeliverable(new Date("2099-09-28T08:00:00.000Z"), 60_000)).toMatchObject({ id: created[0]!.id, jobId: target.jobId, status: "PROCESSING" });
  expect(await repository.claimNextDeliverable(new Date("2099-09-28T08:00:00.000Z"), 60_000)).toBeNull();
});

it("does not deliver a pending OCR job and recovers an expired notification lease", async () => {
  const target = await createTarget("PENDING");
  const repository = new ReceiptExtractionNotificationRepository(prisma);
  const notification = await repository.createForFeishuUpload({ ...target, conversationId: target.conversationId, chatId: "oc-notification" });
  const now = new Date("2099-09-28T09:00:00.000Z");

  expect(await repository.claimNextDeliverable(now, 60_000)).toBeNull();
  await prisma.asyncJob.update({ where: { id: target.jobId }, data: { status: "REVIEW_REQUIRED" } });
  expect(await repository.claimNextDeliverable(now, 60_000)).toMatchObject({ id: notification.id, jobId: target.jobId });
  expect(await repository.recoverExpiredLeases(new Date("2099-09-28T09:02:00.000Z"))).toBe(1);
  await expect(prisma.receiptExtractionNotification.findUniqueOrThrow({ where: { id: notification.id } })).resolves.toMatchObject({ status: "RETRY_WAIT", leaseUntil: null });
});

async function createTarget(status: "PENDING" | "SUCCEEDED") {
  const employee = await prisma.employee.create({ data: { id: "notification-employee", displayName: "通知员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: employee.id } });
  const receipt = await prisma.receipt.create({ data: { claimId: claim.id, objectKey: `claims/notification-${status}`, contentHash: `notification-${status}`, mimeType: "image/png" } });
  const conversation = await prisma.agentConversation.create({ data: { employeeId: employee.id, kind: "PRIVATE", scopeKey: "private" } });
  const job = await prisma.asyncJob.create({ data: { kind: "RECEIPT_EXTRACTION", status, claimId: claim.id, receiptId: receipt.id } });
  return { jobId: job.id, receiptId: receipt.id, claimId: claim.id, conversationId: conversation.id };
}
