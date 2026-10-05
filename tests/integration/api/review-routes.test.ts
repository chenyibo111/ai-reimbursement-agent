import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { GET } from "@/app/api/admin/reviews/route";
import { POST as claimReview } from "@/app/api/admin/reviews/[reviewId]/claim/route";
import { POST as resolveReview } from "@/app/api/admin/reviews/[reviewId]/resolve/route";
import { POST as retryReview } from "@/app/api/admin/reviews/[reviewId]/retry/route";
import { PATCH as updateRole } from "@/app/api/admin/employees/[employeeId]/role/route";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createSessionToken } from "@/src/server/session";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.SESSION_SECRET = "test-session-secret";
  await prisma.$connect();
});

beforeEach(async () => {
  await prisma.reviewCase.deleteMany();
  await prisma.asyncJob.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.submissionSnapshot.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.claimDraft.deleteMany();
  await prisma.policyDocumentSnapshot.deleteMany();
  await prisma.policySource.deleteMany();
  await prisma.employee.deleteMany();
});

afterAll(async () => prisma.$disconnect());

it("does not expose review cases to an ordinary employee", async () => {
  await prisma.employee.create({ data: { id: "review-employee", displayName: "员工" } });

  expect((await GET(requestFor("review-employee"))).status).toBe(403);
});

it("only the assigned reviewer can resolve OCR corrections and every correction is audited", async () => {
  const review = await createOcrReview();
  const reviewerToken = tokenFor("reviewer-a");

  expect((await claimReview(requestFor("reviewer-a", "POST"), { params: Promise.resolve({ reviewId: review.id }) })).status).toBe(200);
  expect((await resolveReview(requestFor("reviewer-b", "POST", { action: "CONFIRM" }), { params: Promise.resolve({ reviewId: review.id }) })).status).toBe(403);

  const resolved = await resolveReview(
    requestFor("reviewer-a", "POST", { action: "CORRECT_FIELDS", expectedVersion: 0, corrections: { invoiceNumber: "REVIEW-INV-001", totalAmountCents: 42000 } }),
    { params: Promise.resolve({ reviewId: review.id }) },
  );
  expect(resolved.status).toBe(200);
  expect(reviewerToken).toContain(".");
  await expect(prisma.expenseItem.findUniqueOrThrow({ where: { id: review.expenseId } })).resolves.toMatchObject({ invoiceNumber: "REVIEW-INV-001", amountCents: 42000, invoiceSource: "USER_ENTERED", amountSource: "USER_ENTERED" });
  expect(await prisma.auditEvent.count({ where: { claimId: review.claimId, actorId: "reviewer-a", type: "REVIEW_FIELD_CORRECTED" } })).toBe(2);
  await expect(prisma.claimDraft.findUniqueOrThrow({ where: { id: review.claimId } })).resolves.toMatchObject({ version: 1 });
});

it("creates the missing expense item when a reviewer supplies a low-confidence receipt amount", async () => {
  const review = await createOcrReview();
  await prisma.expenseItem.delete({ where: { id: review.expenseId } });
  await claimReview(requestFor("reviewer-a", "POST"), { params: Promise.resolve({ reviewId: review.id }) });

  const response = await resolveReview(
    requestFor("reviewer-a", "POST", {
      action: "CORRECT_FIELDS",
      expectedVersion: 0,
      corrections: { invoiceNumber: "REVIEW-INV-NEW", issuedOn: "2026-09-18", totalAmountCents: 10123 },
    }),
    { params: Promise.resolve({ reviewId: review.id }) },
  );

  expect(response.status).toBe(200);
  await expect(prisma.expenseItem.findFirstOrThrow({ where: { claimId: review.claimId, receiptId: review.receiptId } })).resolves.toMatchObject({
    invoiceNumber: "REVIEW-INV-NEW",
    amountCents: 10123,
    invoiceSource: "USER_ENTERED",
    issuedOnSource: "USER_ENTERED",
    amountSource: "USER_ENTERED",
  });
});

it("turns a reviewer request into a claim clarification instead of exposing internal failure details", async () => {
  const review = await createOcrReview();
  await claimReview(requestFor("reviewer-a", "POST"), { params: Promise.resolve({ reviewId: review.id }) });

  const response = await resolveReview(
    requestFor("reviewer-a", "POST", { action: "REQUEST_INFORMATION", message: "请确认此次住宿对应的出差事由。" }),
    { params: Promise.resolve({ reviewId: review.id }) },
  );

  expect(response.status).toBe(200);
  await expect(prisma.clarification.findFirstOrThrow({ where: { claimId: review.claimId } })).resolves.toMatchObject({ field: "review", prompt: "请确认此次住宿对应的出差事由。" });
});

it("allows only an administrator to retry policy synchronization and retains the review audit trail", async () => {
  await prisma.employee.createMany({ data: [{ id: "policy-admin", displayName: "管理员", role: "ADMIN" }, { id: "policy-employee", displayName: "员工" }] });
  const source = await prisma.policySource.create({ data: { type: "FEISHU_DOCX", canonicalUrl: "https://example.feishu.cn/docx/review-policy", resourceToken: "review-policy", title: "制度", createdByEmployeeId: "policy-admin" } });
  const job = await prisma.asyncJob.create({ data: { kind: "POLICY_SOURCE_SYNC", status: "REVIEW_REQUIRED", policySourceId: source.id } });
  const review = await prisma.reviewCase.create({ data: { kind: "POLICY_SYNC", jobId: job.id, policySourceId: source.id, reasonCode: "SYNC_FAILED" } });

  expect((await retryReview(requestFor("policy-employee", "POST"), { params: Promise.resolve({ reviewId: review.id }) })).status).toBe(403);
  expect((await retryReview(requestFor("policy-admin", "POST"), { params: Promise.resolve({ reviewId: review.id }) })).status).toBe(202);
  await expect(prisma.asyncJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toMatchObject({ status: "PENDING", failureCode: null });
  await expect(prisma.reviewCase.findUniqueOrThrow({ where: { id: review.id } })).resolves.toMatchObject({ status: "RESOLVED" });
});

it("does not allow the final administrator to remove their administrative role", async () => {
  await prisma.employee.create({ data: { id: "only-admin", displayName: "唯一管理员", role: "ADMIN" } });

  const response = await updateRole(requestFor("only-admin", "PATCH", { role: "FINANCE_REVIEWER" }), { params: Promise.resolve({ employeeId: "only-admin" }) });
  expect(response.status).toBe(409);
  await expect(prisma.employee.findUniqueOrThrow({ where: { id: "only-admin" } })).resolves.toMatchObject({ role: "ADMIN" });
});

async function createOcrReview() {
  await prisma.employee.createMany({ data: [
    { id: "review-owner", displayName: "单据员工" },
    { id: "reviewer-a", displayName: "复核员 A", role: "FINANCE_REVIEWER" },
    { id: "reviewer-b", displayName: "复核员 B", role: "FINANCE_REVIEWER" },
  ] });
  const claim = await prisma.claimDraft.create({ data: { employeeId: "review-owner" } });
  const receipt = await prisma.receipt.create({ data: { claimId: claim.id, objectKey: "claims/review-api", contentHash: "review-api-hash", mimeType: "application/pdf" } });
  const expense = await prisma.expenseItem.create({ data: { claimId: claim.id, receiptId: receipt.id, amountCents: 38600, amountSource: "EXTRACTED", invoiceNumber: "LOW-CONFIDENCE", invoiceSource: "EXTRACTED" } });
  const job = await prisma.asyncJob.create({ data: { kind: "RECEIPT_EXTRACTION", status: "REVIEW_REQUIRED", claimId: claim.id, receiptId: receipt.id } });
  const review = await prisma.reviewCase.create({ data: { kind: "RECEIPT_OCR", jobId: job.id, claimId: claim.id, receiptId: receipt.id, reasonCode: "OCR_LOW_CONFIDENCE" } });
  return { ...review, claimId: claim.id, expenseId: expense.id };
}

function tokenFor(actorId: string) {
  return createSessionToken(actorId, process.env.SESSION_SECRET!);
}

function requestFor(actorId: string, method = "GET", body?: unknown) {
  return new Request("http://localhost/api/admin/reviews", {
    method,
    headers: { cookie: `reimbursement_session=${tokenFor(actorId)}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
