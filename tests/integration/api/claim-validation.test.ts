import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { GET } from "@/app/api/claims/[claimId]/validate/route";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createSessionToken } from "@/src/server/session";

const databaseUrl = "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => { process.env.DATABASE_URL = databaseUrl; process.env.SESSION_SECRET = "test-session-secret"; await prisma.$connect(); });
beforeEach(async () => { await prisma.auditEvent.deleteMany(); await prisma.claimDraft.deleteMany(); await prisma.employee.deleteMany(); });
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
