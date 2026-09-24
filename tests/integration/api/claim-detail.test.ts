import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { GET } from "@/app/api/claims/[claimId]/detail/route";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createSessionToken } from "@/src/server/session";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);
beforeAll(async () => { process.env.DATABASE_URL = databaseUrl; process.env.SESSION_SECRET = "test-session-secret"; await prisma.$connect(); });
beforeEach(async () => { await prisma.auditEvent.deleteMany(); await prisma.submissionSnapshot.deleteMany(); await prisma.claimDraft.deleteMany(); await prisma.employee.deleteMany(); await prisma.employee.createMany({ data: [{ id: "employee-1", displayName: "员工" }, { id: "employee-2", displayName: "其他员工" }] }); });
afterAll(async () => prisma.$disconnect());

it("returns only the immutable submitted snapshot to its owner", async () => {
  const claim = await prisma.claimDraft.create({ data: { employeeId: "employee-1", status: "SUBMITTED", purpose: "客户拜访" } });
  await prisma.submissionSnapshot.create({ data: { claimId: claim.id, claimVersion: 0, submissionNumber: "RB20260001", payload: { purpose: "客户拜访", totalAmountCents: 38600, expenseItems: [] } } });
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET!);
  const response = await GET(new Request(`http://localhost/api/claims/${claim.id}/detail`, { headers: { cookie: `reimbursement_session=${token}` } }), { params: Promise.resolve({ claimId: claim.id }) });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ submissionNumber: "RB20260001", totalAmountCents: 38600 });
});
