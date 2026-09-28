import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { createPrismaClient } from "@/src/infrastructure/prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);
const employeeIds = ["async-employee", "deleted-target-employee"];

beforeAll(async () => prisma.$connect());

beforeEach(async () => {
  const claims = await prisma.claimDraft.findMany({ where: { employeeId: { in: employeeIds } }, select: { id: true } });
  const claimIds = claims.map((claim) => claim.id);
  if (claimIds.length > 0) {
    await prisma.reviewCase.deleteMany({ where: { claimId: { in: claimIds } } });
    await prisma.asyncJob.deleteMany({ where: { claimId: { in: claimIds } } });
    await prisma.submissionSnapshot.deleteMany({ where: { claimId: { in: claimIds } } });
    await prisma.claimDraft.deleteMany({ where: { id: { in: claimIds } } });
  }
  await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
});

afterAll(async () => prisma.$disconnect());

it("defaults employees to EMPLOYEE and reuses the one active receipt extraction job", async () => {
  const employee = await prisma.employee.create({ data: { id: "async-employee", displayName: "异步任务员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: employee.id } });
  const receipt = await prisma.receipt.create({
    data: { claimId: claim.id, objectKey: "claims/async-receipt", contentHash: "async-hash", mimeType: "application/pdf" },
  });

  expect(employee.role).toBe("EMPLOYEE");

  const attempts = await Promise.allSettled([
    prisma.asyncJob.create({ data: { kind: "RECEIPT_EXTRACTION", claimId: claim.id, receiptId: receipt.id } }),
    prisma.asyncJob.create({ data: { kind: "RECEIPT_EXTRACTION", claimId: claim.id, receiptId: receipt.id } }),
  ]);

  expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
  expect(await prisma.asyncJob.count({ where: { receiptId: receipt.id, status: { in: ["PENDING", "RUNNING", "RETRY_WAIT"] } } })).toBe(1);
});

it("closes an active extraction job before a deleted receipt clears its target", async () => {
  const employee = await prisma.employee.create({ data: { id: "deleted-target-employee", displayName: "删除目标员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: employee.id } });
  const receipt = await prisma.receipt.create({
    data: { claimId: claim.id, objectKey: "claims/deleted-receipt", contentHash: "deleted-hash", mimeType: "application/pdf" },
  });
  const job = await prisma.asyncJob.create({ data: { kind: "RECEIPT_EXTRACTION", claimId: claim.id, receiptId: receipt.id } });

  await prisma.receipt.delete({ where: { id: receipt.id } });

  await expect(prisma.asyncJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toMatchObject({
    status: "CLOSED",
    failureCode: "TARGET_DELETED",
    receiptId: null,
  });
});
