import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { POST } from "@/app/api/admin/policies/route";
import { PUT } from "@/app/api/admin/policies/[policyVersionId]/rules/route";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createSessionToken } from "@/src/server/session";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => { process.env.DATABASE_URL = databaseUrl; process.env.SESSION_SECRET = "test-session-secret"; await prisma.$connect(); });
beforeEach(async () => { await prisma.inboundChannelEvent.deleteMany(); await prisma.feishuConversation.deleteMany(); await prisma.auditEvent.deleteMany(); await prisma.submissionSnapshot.deleteMany(); await prisma.agentFieldProposal.deleteMany(); await prisma.validationResult.deleteMany(); await prisma.expenseItem.deleteMany(); await prisma.receipt.deleteMany(); await prisma.clarification.deleteMany(); await prisma.claimDraft.deleteMany(); await prisma.policyAuditEvent.deleteMany(); await prisma.policyRule.deleteMany(); await prisma.policyVersion.deleteMany(); await prisma.employee.deleteMany(); });
afterAll(async () => prisma.$disconnect());

it("rejects a non-administrator and lets an allowlisted Feishu employee create a policy draft", async () => {
  await prisma.employee.create({ data: { id: "employee-1", displayName: "普通员工", feishuUserId: "ou_employee" } });
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET!);
  process.env.POLICY_ADMIN_FEISHU_OPEN_IDS = "ou_finance";
  let response = await POST(new Request("http://localhost/api/admin/policies", { method: "POST", headers: { cookie: `reimbursement_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "差旅制度", effectiveFrom: "2026-10-01" }) }));
  expect(response.status).toBe(403);

  await prisma.employee.update({ where: { id: "employee-1" }, data: { feishuUserId: "ou_finance" } });
  response = await POST(new Request("http://localhost/api/admin/policies", { method: "POST", headers: { cookie: `reimbursement_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "差旅制度", effectiveFrom: "2026-10-01" }) }));
  expect(response.status).toBe(201);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ status: "DRAFT", title: "差旅制度" }));
});

it("allows an administrator to save rules only with the current draft version", async () => {
  process.env.POLICY_ADMIN_FEISHU_OPEN_IDS = "ou_finance";
  await prisma.employee.create({ data: { id: "employee-1", displayName: "财务", feishuUserId: "ou_finance" } });
  const draft = await prisma.policyVersion.create({ data: { title: "差旅制度", effectiveFrom: new Date("2026-10-01"), createdByEmployeeId: "employee-1" } });
  const token = createSessionToken("employee-1", process.env.SESSION_SECRET!);
  const response = await PUT(new Request(`http://localhost/api/admin/policies/${draft.id}/rules`, { method: "PUT", headers: { cookie: `reimbursement_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 0, rules: [{ code: "TOTAL", name: "总额上限", type: "CLAIM_TOTAL_MAX", severity: "BLOCKING", config: { maxAmountCents: 100_000 } }] }) }), { params: Promise.resolve({ policyVersionId: draft.id }) });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(expect.objectContaining({ version: 1, rules: [expect.objectContaining({ code: "TOTAL" })] }));
});
