import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { POST } from "@/app/api/claims/[claimId]/fields/route";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createSessionToken } from "@/src/server/session";

const databaseUrl = "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => { process.env.DATABASE_URL = databaseUrl; process.env.SESSION_SECRET = "test-session-secret"; await prisma.$connect(); });
beforeEach(async () => { await prisma.auditEvent.deleteMany(); await prisma.expenseItem.deleteMany(); await prisma.claimDraft.deleteMany(); await prisma.employee.deleteMany(); });
afterAll(async () => prisma.$disconnect());

it("confirms a targeted invoice number and marks it USER_ENTERED", async () => {
  await prisma.employee.create({ data: { id: "employee-1", displayName: "测试员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: "employee-1" } });
  const expense = await prisma.expenseItem.create({ data: { claimId: claim.id, amountCents: 38600, amountSource: "EXTRACTED", invoiceNumber: "LOW-CONFIDENCE", invoiceSource: "EXTRACTED" } });
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET!);
  const response = await POST(
    new Request(`http://localhost/api/claims/${claim.id}/fields`, { method: "POST", headers: { "content-type": "application/json", cookie: `reimbursement_session=${token}` }, body: JSON.stringify({ field: "invoiceNumber", value: "INV-2026-001", expenseItemId: expense.id, expectedVersion: 0 }) }),
    { params: Promise.resolve({ claimId: claim.id }) },
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ field: "invoiceNumber", source: "USER_ENTERED", version: 1 });
  await expect(prisma.expenseItem.findUniqueOrThrow({ where: { id: expense.id } })).resolves.toMatchObject({ invoiceNumber: "INV-2026-001", invoiceSource: "USER_ENTERED" });
});

it("does not advance the claim version when the targeted expense item is absent", async () => {
  await prisma.employee.create({ data: { id: "employee-1", displayName: "测试员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: "employee-1" } });
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET!);
  const response = await POST(
    new Request(`http://localhost/api/claims/${claim.id}/fields`, { method: "POST", headers: { "content-type": "application/json", cookie: `reimbursement_session=${token}` }, body: JSON.stringify({ field: "invoiceNumber", value: "INV-2026-001", expenseItemId: "missing-expense", expectedVersion: 0 }) }),
    { params: Promise.resolve({ claimId: claim.id }) },
  );

  expect(response.status).toBe(404);
  await expect(prisma.claimDraft.findUniqueOrThrow({ where: { id: claim.id } })).resolves.toMatchObject({ version: 0 });
});
