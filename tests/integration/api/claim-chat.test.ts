import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { POST } from "@/app/api/claims/[claimId]/chat/route";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createSessionToken } from "@/src/server/session";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => { process.env.DATABASE_URL = databaseUrl; process.env.SESSION_SECRET = "test-session-secret"; process.env.MODEL_PROVIDER = "fixture"; await prisma.$connect(); });
beforeEach(async () => { await prisma.submissionSnapshot.deleteMany(); await prisma.auditEvent.deleteMany(); await prisma.claimDraft.deleteMany(); await prisma.employee.deleteMany(); });
afterAll(async () => prisma.$disconnect());

it("returns an agent reply and no direct field mutation", async () => {
  await prisma.employee.create({ data: { id: "employee-1", displayName: "测试员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: "employee-1", purpose: "客户拜访" } });
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET!);
  const response = await POST(new Request(`http://localhost/api/claims/${claim.id}/chat`, { method: "POST", headers: { "content-type": "application/json", cookie: `reimbursement_session=${token}` }, body: JSON.stringify({ message: "请帮我检查" }) }), { params: Promise.resolve({ claimId: claim.id }) });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ reply: expect.any(String), proposals: [] }));
});
