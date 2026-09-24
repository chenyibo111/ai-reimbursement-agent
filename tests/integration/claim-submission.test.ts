import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import { POST as requestPreview } from "@/app/api/claims/[claimId]/submission-request/route";
import { POST as submit } from "@/app/api/claims/[claimId]/submit/route";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createConfirmationToken } from "@/src/server/confirmation";
import { createSessionToken } from "@/src/server/session";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);
beforeAll(async () => { process.env.DATABASE_URL = databaseUrl; process.env.SESSION_SECRET = "test-session-secret"; await prisma.$connect(); });
beforeEach(async () => { await prisma.auditEvent.deleteMany(); await prisma.submissionSnapshot.deleteMany(); await prisma.expenseItem.deleteMany(); await prisma.claimDraft.deleteMany(); await prisma.employee.deleteMany(); });
afterEach(async () => { await prisma.submissionSnapshot.deleteMany(); });
afterAll(async () => prisma.$disconnect());

it("submits a confirmed claim into an immutable snapshot", async () => {
  await prisma.employee.create({ data: { id: "employee-1", displayName: "测试员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: "employee-1", purpose: "客户拜访", expenseItems: { create: { amountCents: 38600, amountSource: "USER_ENTERED" } } } });
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET!);
  const request = new Request(`http://localhost/api/claims/${claim.id}/submission-request`, { method: "POST", headers: { cookie: `reimbursement_session=${token}` } });
  const previewResponse = await requestPreview(request, { params: Promise.resolve({ claimId: claim.id }) });
  const preview = await previewResponse.json() as { token: string };
  const submitted = await submit(new Request(`http://localhost/api/claims/${claim.id}/submit`, { method: "POST", headers: { "content-type": "application/json", cookie: `reimbursement_session=${token}` }, body: JSON.stringify({ confirmationToken: preview.token }) }), { params: Promise.resolve({ claimId: claim.id }) });

  expect(submitted.status).toBe(201);
  await expect(prisma.claimDraft.findUniqueOrThrow({ where: { id: claim.id } })).resolves.toMatchObject({ status: "SUBMITTED" });
  await expect(prisma.submissionSnapshot.findFirstOrThrow({ where: { claimId: claim.id } })).resolves.toMatchObject({ claimVersion: 0, payload: expect.objectContaining({ totalAmountCents: 38600 }) });
});

it("blocks both confirmation and submission when a claim has an active duplicate validation", async () => {
  await prisma.employee.create({ data: { id: "employee-1", displayName: "测试员工" } });
  const claim = await prisma.claimDraft.create({
    data: {
      employeeId: "employee-1",
      purpose: "客户拜访",
      expenseItems: { create: { amountCents: 38600, amountSource: "USER_ENTERED" } },
      validationResults: { create: { code: "DUPLICATE_INVOICE", severity: "BLOCKING", message: "已提交相同发票号码", ruleVersion: "v1" } },
    },
  });
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET!);
  const preview = await requestPreview(new Request(`http://localhost/api/claims/${claim.id}/submission-request`, { method: "POST", headers: { cookie: `reimbursement_session=${token}` } }), { params: Promise.resolve({ claimId: claim.id }) });

  expect(preview.status).toBe(409);
  await expect(preview.json()).resolves.toEqual(expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code: "DUPLICATE_RECEIPT", severity: "BLOCKING" })]) }));

  const confirmationToken = createConfirmationToken({ claimId: claim.id, version: claim.version, actorId: "employee-1" });
  const submitted = await submit(new Request(`http://localhost/api/claims/${claim.id}/submit`, { method: "POST", headers: { "content-type": "application/json", cookie: `reimbursement_session=${token}` }, body: JSON.stringify({ confirmationToken }) }), { params: Promise.resolve({ claimId: claim.id }) });

  expect(submitted.status).toBe(409);
  await expect(prisma.claimDraft.findUniqueOrThrow({ where: { id: claim.id } })).resolves.toMatchObject({ status: "DRAFT" });
});
