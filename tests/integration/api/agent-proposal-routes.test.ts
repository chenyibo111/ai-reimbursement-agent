import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { POST as accept } from "@/app/api/claims/[claimId]/agent-proposals/[proposalId]/accept/route";
import { POST as reject } from "@/app/api/claims/[claimId]/agent-proposals/[proposalId]/reject/route";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createSessionToken } from "@/src/server/session";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => { process.env.DATABASE_URL = databaseUrl; process.env.SESSION_SECRET = "test-session-secret"; await prisma.$connect(); });
beforeEach(async () => { await prisma.claimDraft.deleteMany(); await prisma.employee.deleteMany(); });
afterAll(async () => prisma.$disconnect());

it("accepts only the stored suggestion and records the employee confirmation", async () => {
  const { claim, proposal, cookie } = await pendingPurposeProposal();
  const invalid = await accept(new Request(`http://localhost/api/claims/${claim.id}/agent-proposals/${proposal.id}/accept`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ expectedVersion: 0, field: "purpose", value: "伪造值" }) }), { params: Promise.resolve({ claimId: claim.id, proposalId: proposal.id }) });
  expect(invalid.status).toBe(400);
  const response = await accept(new Request(`http://localhost/api/claims/${claim.id}/agent-proposals/${proposal.id}/accept`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ expectedVersion: 0 }) }), { params: Promise.resolve({ claimId: claim.id, proposalId: proposal.id }) });
  expect(response.status).toBe(200);
  expect(await prisma.claimDraft.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ purpose: "客户拜访", version: 1 });
  expect(await prisma.agentFieldProposal.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({ status: "ACCEPTED" });
  expect(await prisma.auditEvent.findFirstOrThrow({ where: { claimId: claim.id, type: "AGENT_FIELD_ACCEPTED" } })).toMatchObject({ payload: { proposalId: proposal.id, field: "purpose" } });
});

it("rejects without changing the draft and prevents stale confirmation", async () => {
  const { claim, proposal, cookie } = await pendingPurposeProposal();
  const response = await reject(new Request(`http://localhost/api/claims/${claim.id}/agent-proposals/${proposal.id}/reject`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ expectedVersion: 0 }) }), { params: Promise.resolve({ claimId: claim.id, proposalId: proposal.id }) });
  expect(response.status).toBe(200);
  expect(await prisma.claimDraft.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ purpose: null, version: 1 });
  const stale = await accept(new Request(`http://localhost/api/claims/${claim.id}/agent-proposals/${proposal.id}/accept`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ expectedVersion: 0 }) }), { params: Promise.resolve({ claimId: claim.id, proposalId: proposal.id }) });
  expect(stale.status).toBe(409);
});

it("expires sibling suggestions after one is resolved and records the field update", async () => {
  const { claim, proposal, cookie } = await pendingPurposeProposal();
  const sibling = await prisma.agentFieldProposal.create({ data: { claimId: claim.id, targetRef: "claim", field: "purpose", value: "客户拜访餐饮", reason: "另一项建议", claimVersion: 0 } });

  const response = await accept(new Request(`http://localhost/api/claims/${claim.id}/agent-proposals/${proposal.id}/accept`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ expectedVersion: 0 }) }), { params: Promise.resolve({ claimId: claim.id, proposalId: proposal.id }) });

  expect(response.status).toBe(200);
  await expect(prisma.agentFieldProposal.findUniqueOrThrow({ where: { id: sibling.id } })).resolves.toMatchObject({ status: "EXPIRED", resolvedAt: expect.any(Date) });
  await expect(prisma.auditEvent.findFirstOrThrow({ where: { claimId: claim.id, type: "CLAIM_FIELD_UPDATED" } })).resolves.toMatchObject({ payload: expect.objectContaining({ field: "purpose", source: "USER_ENTERED" }) });
});

async function pendingPurposeProposal() {
  await prisma.employee.create({ data: { id: "employee-1", displayName: "测试员工" } });
  const claim = await prisma.claimDraft.create({ data: { employeeId: "employee-1" } });
  const proposal = await prisma.agentFieldProposal.create({ data: { claimId: claim.id, targetRef: "claim", field: "purpose", value: "客户拜访", reason: "补齐事由", claimVersion: 0 } });
  return { claim, proposal, cookie: `reimbursement_session=${createSessionToken("employee-1", process.env.SESSION_SECRET!)}` };
}
