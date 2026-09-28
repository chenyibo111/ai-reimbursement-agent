import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PrismaReviewCaseRepository } from "@/src/infrastructure/prisma/review-case-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);
const employeeIds = ["review-owner", "reviewer-a", "reviewer-b"];

beforeAll(async () => prisma.$connect());
beforeEach(async () => {
  const claims = await prisma.claimDraft.findMany({ where: { employeeId: { in: employeeIds } }, select: { id: true } });
  const claimIds = claims.map((claim) => claim.id);
  if (claimIds.length > 0) {
    await prisma.reviewCase.deleteMany({ where: { claimId: { in: claimIds } } });
    await prisma.asyncJob.deleteMany({ where: { claimId: { in: claimIds } } });
    await prisma.auditEvent.deleteMany({ where: { claimId: { in: claimIds } } });
    await prisma.submissionSnapshot.deleteMany({ where: { claimId: { in: claimIds } } });
    await prisma.claimDraft.deleteMany({ where: { id: { in: claimIds } } });
  }
  await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
});
afterAll(async () => prisma.$disconnect());

it("allows exactly one reviewer to claim an open OCR review case", async () => {
  await prisma.employee.createMany({ data: [
    { id: "review-owner", displayName: "员工" },
    { id: "reviewer-a", displayName: "复核员 A", role: "FINANCE_REVIEWER" },
    { id: "reviewer-b", displayName: "复核员 B", role: "FINANCE_REVIEWER" },
  ] });
  const claim = await prisma.claimDraft.create({ data: { employeeId: "review-owner" } });
  const receipt = await prisma.receipt.create({ data: { claimId: claim.id, objectKey: "claims/review", contentHash: "review-hash", mimeType: "application/pdf" } });
  const job = await prisma.asyncJob.create({ data: { kind: "RECEIPT_EXTRACTION", claimId: claim.id, receiptId: receipt.id, status: "REVIEW_REQUIRED" } });
  const review = await prisma.reviewCase.create({ data: { kind: "RECEIPT_OCR", jobId: job.id, claimId: claim.id, receiptId: receipt.id, reasonCode: "OCR_LOW_CONFIDENCE" } });
  const repository = new PrismaReviewCaseRepository(prisma);

  const claims = await Promise.all([repository.claimOpen({ reviewId: review.id, reviewerId: "reviewer-a" }), repository.claimOpen({ reviewId: review.id, reviewerId: "reviewer-b" })]);

  expect(claims.filter(Boolean)).toHaveLength(1);
  await expect(prisma.reviewCase.findUniqueOrThrow({ where: { id: review.id } })).resolves.toMatchObject({ status: "CLAIMED", assignedReviewerId: expect.stringMatching(/^reviewer-/) });
});
