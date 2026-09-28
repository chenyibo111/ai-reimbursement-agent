import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { processAsyncJob } from "@/src/application/process-async-job";
import { runAsyncJobWorkerOnce } from "@/src/application/run-async-job-worker";
import { PrismaAsyncJobRepository } from "@/src/infrastructure/prisma/async-job-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);
const employeeId = "flow-ocr-employee";

beforeAll(async () => prisma.$connect());
beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

async function cleanup() {
  const claims = await prisma.claimDraft.findMany({ where: { employeeId }, select: { id: true } });
  const claimIds = claims.map((claim) => claim.id);
  if (claimIds.length) {
    await prisma.reviewCase.deleteMany({ where: { claimId: { in: claimIds } } });
    await prisma.asyncJob.deleteMany({ where: { claimId: { in: claimIds } } });
    await prisma.submissionSnapshot.deleteMany({ where: { claimId: { in: claimIds } } });
    await prisma.claimDraft.deleteMany({ where: { id: { in: claimIds } } });
  }
  await prisma.employee.deleteMany({ where: { id: employeeId } });
}

it("moves an enqueued receipt extraction through one durable worker poll to success", async () => {
  await prisma.employee.create({ data: { id: employeeId, displayName: "OCR 流程员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId } });
  const receipt = await prisma.receipt.create({ data: { claimId: claim.id, objectKey: "claims/flow-ocr", contentHash: "flow-ocr", mimeType: "application/pdf" } });
  const jobs = new PrismaAsyncJobRepository(prisma);
  const job = await jobs.enqueueJob({ kind: "RECEIPT_EXTRACTION", claimId: claim.id, receiptId: receipt.id });
  await prisma.asyncJob.update({ where: { id: job.id }, data: { availableAt: new Date("2000-01-01T00:00:00.000Z") } });

  expect(await runAsyncJobWorkerOnce({
    jobs,
    process: (claimed) => processAsyncJob(claimed, {
      jobs,
      extractReceipt: async () => ({ receiptId: receipt.id, expenseItemCreated: true, validationIssues: [] }),
      syncPolicySource: async () => undefined,
    }),
    now: () => new Date("2001-01-01T00:00:00.000Z"),
    leaseMs: 60_000,
  })).toBe(true);

  await expect(prisma.asyncJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toMatchObject({ status: "SUCCEEDED", attemptCount: 1 });
});
