import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { GET } from "@/app/api/claims/[claimId]/route";
import { POST } from "@/app/api/claims/route";
import { createSessionToken } from "@/src/server/session";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.DATABASE_URL = databaseUrl;
  await prisma.$connect();
});

beforeEach(async () => {
  await prisma.submissionSnapshot.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.claimDraft.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.employee.create({ data: { id: "session-employee", displayName: "会话员工" } });
  await prisma.employee.create({ data: { id: "forged-employee", displayName: "被伪造员工" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

it("ignores a forged employeeId and creates a claim for the authenticated employee", async () => {
  const token = createSessionToken("session-employee", process.env.SESSION_SECRET!);
  const request = new Request("http://localhost/api/claims", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `reimbursement_session=${token}`,
    },
    body: JSON.stringify({ purpose: "客户拜访", employeeId: "forged-employee" }),
  });

  const response = await POST(request);
  const result = (await response.json()) as { id: string; status: string; version: number };
  const draft = await prisma.claimDraft.findUniqueOrThrow({ where: { id: result.id } });
  const event = await prisma.auditEvent.findFirstOrThrow({ where: { claimId: result.id } });

  expect(response.status).toBe(201);
  expect(result).toMatchObject({ status: "DRAFT", version: 0 });
  expect(draft.employeeId).toBe("session-employee");
  expect(event).toMatchObject({ type: "CLAIM_CREATED", actorId: "session-employee" });
});

it("returns a summary only to the claim owner", async () => {
  const draft = await prisma.claimDraft.create({
    data: {
      employeeId: "session-employee",
      purpose: "客户午餐",
      expenseItems: { create: { amountCents: 38600, amountSource: "USER_ENTERED" } },
    },
  });
  const ownerToken = createSessionToken("session-employee", process.env.SESSION_SECRET!);
  const otherToken = createSessionToken("forged-employee", process.env.SESSION_SECRET!);
  const context = { params: Promise.resolve({ claimId: draft.id }) };

  const ownerResponse = await GET(
    new Request(`http://localhost/api/claims/${draft.id}`, {
      headers: { cookie: `reimbursement_session=${ownerToken}` },
    }),
    context,
  );
  const otherResponse = await GET(
    new Request(`http://localhost/api/claims/${draft.id}`, {
      headers: { cookie: `reimbursement_session=${otherToken}` },
    }),
    context,
  );

  expect(ownerResponse.status).toBe(200);
  await expect(ownerResponse.json()).resolves.toMatchObject({ id: draft.id, totalAmountCents: 38600 });
  expect(otherResponse.status).toBe(403);
});
