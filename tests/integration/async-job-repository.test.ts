import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PrismaAsyncJobRepository } from "@/src/infrastructure/prisma/async-job-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);
const employeeIds = ["async-employee", "deleted-target-employee", "queue-employee", "lease-employee", "retry-employee", "missing-employee"];

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

it("reuses one active job when concurrent callers enqueue the same receipt", async () => {
  const target = await createExtractionTarget("queue");
  const repository = new PrismaAsyncJobRepository(prisma);

  const jobs = await Promise.all(Array.from({ length: 4 }, () => repository.enqueueJob({
    kind: "RECEIPT_EXTRACTION",
    claimId: target.claimId,
    receiptId: target.receiptId,
  })));

  expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
  expect(await prisma.asyncJob.count({ where: { receiptId: target.receiptId } })).toBe(1);
});

it("allows exactly one concurrent worker to claim an available job", async () => {
  const target = await createExtractionTarget("lease");
  const repository = new PrismaAsyncJobRepository(prisma);
  await repository.enqueueJob({ kind: "RECEIPT_EXTRACTION", claimId: target.claimId, receiptId: target.receiptId });
  const now = new Date("2099-09-28T01:00:00.000Z");

  const claims = await Promise.all([
    repository.claimNextJob(now, 60_000),
    repository.claimNextJob(now, 60_000),
  ]);

  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(claims.find(Boolean)).toMatchObject({ status: "RUNNING", leaseUntil: new Date("2099-09-28T01:01:00.000Z") });
});

it("recovers expired leases and escalates a final retry to review", async () => {
  const target = await createExtractionTarget("retry");
  const repository = new PrismaAsyncJobRepository(prisma);
  const created = await repository.enqueueJob({ kind: "RECEIPT_EXTRACTION", claimId: target.claimId, receiptId: target.receiptId });
  const startedAt = new Date("2099-09-28T02:00:00.000Z");
  await repository.claimNextJob(startedAt, 60_000);

  expect(await repository.recoverExpiredLeases(new Date("2099-09-28T02:02:00.000Z"))).toBeGreaterThanOrEqual(1);
  await expect(prisma.asyncJob.findUniqueOrThrow({ where: { id: created.id } })).resolves.toMatchObject({ status: "RETRY_WAIT", availableAt: new Date("2099-09-28T02:02:00.000Z") });

  await prisma.asyncJob.update({ where: { id: created.id }, data: { status: "RUNNING", attemptCount: 3, leaseUntil: new Date("2026-09-28T03:00:00.000Z") } });
  await repository.markRetryWait(created.id, "OCR_PROVIDER_UNAVAILABLE", new Date("2026-09-28T02:03:00.000Z"));
  await expect(prisma.asyncJob.findUniqueOrThrow({ where: { id: created.id } })).resolves.toMatchObject({ status: "REVIEW_REQUIRED", failureCode: "OCR_RETRY_EXHAUSTED" });
});

it("closes a running job when its target is no longer available", async () => {
  const target = await createExtractionTarget("missing");
  const repository = new PrismaAsyncJobRepository(prisma);
  const created = await repository.enqueueJob({ kind: "RECEIPT_EXTRACTION", claimId: target.claimId, receiptId: target.receiptId });
  await repository.claimNextJob(new Date("2026-09-28T04:00:00.000Z"), 60_000);

  await repository.closeMissingTarget(created.id);

  await expect(prisma.asyncJob.findUniqueOrThrow({ where: { id: created.id } })).resolves.toMatchObject({ status: "CLOSED", failureCode: "TARGET_MISSING", leaseUntil: null });
});

it("creates an admin-only policy review case when a policy sync exhausts retries", async () => {
  await prisma.reviewCase.deleteMany();
  await prisma.asyncJob.deleteMany({ where: { kind: "POLICY_SOURCE_SYNC" } });
  await prisma.policyChunk.deleteMany();
  await prisma.policyDocumentSnapshot.deleteMany();
  await prisma.policySource.deleteMany();
  const source = await prisma.policySource.create({
    data: { type: "FEISHU_DOCX", canonicalUrl: "https://acme.feishu.cn/docx/POLICY_RETRY_001", resourceToken: "POLICY_RETRY_001", title: "重试制度", createdByEmployeeId: "admin" },
  });
  const repository = new PrismaAsyncJobRepository(prisma);
  const job = await repository.enqueueJob({ kind: "POLICY_SOURCE_SYNC", policySourceId: source.id });
  await prisma.asyncJob.update({ where: { id: job.id }, data: { status: "RUNNING", attemptCount: 3, leaseUntil: new Date("2099-09-28T06:00:00.000Z") } });

  await repository.markRetryWait(job.id, "EMBEDDING_TIMEOUT", new Date("2099-09-28T06:01:00.000Z"));

  await expect(prisma.reviewCase.findFirstOrThrow({ where: { jobId: job.id } })).resolves.toMatchObject({ kind: "POLICY_SYNC", status: "OPEN", reasonCode: "EMBEDDING_TIMEOUT", policySourceId: source.id });
});

async function createExtractionTarget(suffix: "queue" | "lease" | "retry" | "missing") {
  const employee = await prisma.employee.create({ data: { id: `${suffix}-employee`, displayName: `${suffix} 队列员工` } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: employee.id } });
  const receipt = await prisma.receipt.create({
    data: { claimId: claim.id, objectKey: `claims/${suffix}-receipt`, contentHash: `${suffix}-hash`, mimeType: "application/pdf" },
  });
  return { claimId: claim.id, receiptId: receipt.id };
}
