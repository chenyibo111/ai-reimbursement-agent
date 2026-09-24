import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { POST } from "@/app/api/claims/[claimId]/receipts/route";
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
  await prisma.receipt.deleteMany();
  await prisma.claimDraft.deleteMany();
  await prisma.employee.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

it("rejects an unsafe upload before it can create a receipt record", async () => {
  await prisma.employee.create({ data: { id: "employee-1", displayName: "测试员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: "employee-1" } });
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array([0x4d, 0x5a, 0x90, 0x00])], { type: "application/pdf" }), "invoice.pdf");
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET!);

  const response = await POST(
    new Request(`http://localhost/api/claims/${claim.id}/receipts`, {
      method: "POST",
      headers: { cookie: `reimbursement_session=${token}` },
      body: form,
    }),
    { params: Promise.resolve({ claimId: claim.id }) },
  );

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ error: "file signature does not match declared type" });
  expect(await prisma.receipt.count({ where: { claimId: claim.id } })).toBe(0);
});
