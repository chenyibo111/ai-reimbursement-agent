import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { POST } from "@/app/api/claims/[claimId]/receipts/[receiptId]/extract/route";
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
  await prisma.submissionSnapshot.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.validationResult.deleteMany();
  await prisma.expenseItem.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.claimDraft.deleteMany();
  await prisma.employee.deleteMany();
});

afterAll(async () => prisma.$disconnect());

it("stores the extraction but does not double count a duplicate file", async () => {
  await prisma.employee.create({ data: { id: "employee-1", displayName: "测试员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: "employee-1" } });
  const prior = await prisma.receipt.create({ data: { claimId: claim.id, objectKey: "claims/prior", contentHash: "same-hash", mimeType: "application/pdf", status: "EXTRACTED" } });
  await prisma.expenseItem.create({ data: { claimId: claim.id, receiptId: prior.id, amountCents: 38600, amountSource: "EXTRACTED" } });
  const current = await prisma.receipt.create({ data: { claimId: claim.id, objectKey: "claims/current", contentHash: "same-hash", mimeType: "application/pdf" } });
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET!);

  const response = await POST(
    new Request(`http://localhost/api/claims/${claim.id}/receipts/${current.id}/extract`, { method: "POST", headers: { cookie: `reimbursement_session=${token}` } }),
    { params: Promise.resolve({ claimId: claim.id, receiptId: current.id }) },
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ receiptId: current.id, expenseItemCreated: false, validationIssues: [{ code: "DUPLICATE_FILE" }] });
  await expect(prisma.receipt.findUniqueOrThrow({ where: { id: current.id } })).resolves.toMatchObject({ status: "EXTRACTED", receiptType: "VAT_INVOICE" });
  expect(await prisma.expenseItem.count({ where: { claimId: claim.id } })).toBe(1);
  expect(await prisma.validationResult.findFirst({ where: { claimId: claim.id, code: "DUPLICATE_FILE" } })).toBeTruthy();
});
