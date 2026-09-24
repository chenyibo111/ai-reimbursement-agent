import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { GET } from "@/app/api/claims/[claimId]/validate/route";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createSessionToken } from "@/src/server/session";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => { process.env.DATABASE_URL = databaseUrl; process.env.SESSION_SECRET = "test-session-secret"; await prisma.$connect(); });
beforeEach(async () => { await prisma.submissionSnapshot.deleteMany(); await prisma.auditEvent.deleteMany(); await prisma.claimDraft.deleteMany(); await prisma.employee.deleteMany(); });
afterAll(async () => prisma.$disconnect());

it("returns blocking issues for an incomplete claim owned by the session employee", async () => {
  await prisma.employee.create({ data: { id: "employee-1", displayName: "测试员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: "employee-1" } });
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET!);

  const response = await GET(
    new Request(`http://localhost/api/claims/${claim.id}/validate`, { headers: { cookie: `reimbursement_session=${token}` } }),
    { params: Promise.resolve({ claimId: claim.id }) },
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(
    expect.objectContaining({ issues: expect.arrayContaining([{ code: "PURPOSE_REQUIRED", severity: "BLOCKING" }, { code: "EXPENSE_REQUIRED", severity: "BLOCKING" }]) }),
  );
});

it("requires confirmation when an extracted invoice number has low confidence", async () => {
  await prisma.employee.create({ data: { id: "employee-1", displayName: "测试员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: "employee-1", purpose: "客户拜访" } });
  const receipt = await prisma.receipt.create({ data: { claimId: claim.id, objectKey: "claims/low-confidence", contentHash: "low-confidence-hash", mimeType: "application/pdf", status: "EXTRACTED", extractionPayload: { invoiceNumber: { value: "INV-LOW", confidence: 0.62, source: "EXTRACTED" }, issuedOn: { value: "2026-09-20", confidence: 0.99, source: "EXTRACTED" }, totalAmountCents: { value: 38600, confidence: 0.99, source: "EXTRACTED" } } } });
  await prisma.expenseItem.create({ data: { claimId: claim.id, receiptId: receipt.id, amountCents: 38600, amountSource: "EXTRACTED" } });
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET!);

  const response = await GET(new Request(`http://localhost/api/claims/${claim.id}/validate`, { headers: { cookie: `reimbursement_session=${token}` } }), { params: Promise.resolve({ claimId: claim.id }) });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ issues: expect.arrayContaining([{ code: "CONFIRM_INVOICE_NUMBER", severity: "BLOCKING" }]) }));
});

it("clears a low-confidence confirmation requirement after the employee confirms the matching expense field", async () => {
  await prisma.employee.create({ data: { id: "employee-1", displayName: "测试员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: "employee-1", purpose: "客户拜访" } });
  const receipt = await prisma.receipt.create({ data: { claimId: claim.id, objectKey: "claims/confirmed-low-confidence", contentHash: "confirmed-low-confidence-hash", mimeType: "application/pdf", status: "EXTRACTED", extractionPayload: { invoiceNumber: { value: "INV-LOW", confidence: 0.62, source: "EXTRACTED" } } } });
  await prisma.expenseItem.create({ data: { claimId: claim.id, receiptId: receipt.id, amountCents: 38600, amountSource: "EXTRACTED", invoiceNumber: "INV-CONFIRMED", invoiceSource: "USER_ENTERED" } });
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET!);

  const response = await GET(new Request(`http://localhost/api/claims/${claim.id}/validate`, { headers: { cookie: `reimbursement_session=${token}` } }), { params: Promise.resolve({ claimId: claim.id }) });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ issues: expect.not.arrayContaining([{ code: "CONFIRM_INVOICE_NUMBER", severity: "BLOCKING" }]) }));
});
