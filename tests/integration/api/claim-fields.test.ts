import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { POST } from "@/app/api/claims/[claimId]/fields/route";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createSessionToken } from "@/src/server/session";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => { process.env.DATABASE_URL = databaseUrl; process.env.SESSION_SECRET = "test-session-secret"; await prisma.$connect(); });
beforeEach(async () => { await prisma.submissionSnapshot.deleteMany(); await prisma.auditEvent.deleteMany(); await prisma.claimDraft.deleteMany(); await prisma.employee.deleteMany(); });
afterAll(async () => prisma.$disconnect());

it("updates the owner's purpose once and rejects a stale version", async () => {
  await prisma.employee.create({ data: { id: "employee-1", displayName: "测试员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: "employee-1" } });
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET!);
  const makeRequest = (expectedVersion: number) => new Request(`http://localhost/api/claims/${claim.id}/fields`, { method: "POST", headers: { "content-type": "application/json", cookie: `reimbursement_session=${token}` }, body: JSON.stringify({ field: "purpose", value: "客户午餐", expectedVersion }) });

  const success = await POST(makeRequest(0), { params: Promise.resolve({ claimId: claim.id }) });
  const stale = await POST(makeRequest(0), { params: Promise.resolve({ claimId: claim.id }) });

  expect(success.status).toBe(200);
  await expect(success.json()).resolves.toMatchObject({ purpose: "客户午餐", version: 1, fields: { purpose: { source: "USER_ENTERED" } } });
  expect(stale.status).toBe(409);
});
