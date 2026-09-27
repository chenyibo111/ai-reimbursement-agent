import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { GET, POST } from "@/app/api/admin/policy-sources/route";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";
import { createSessionToken } from "@/src/server/session";
const url = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(url);
beforeAll(async () => { process.env.DATABASE_URL=url; process.env.SESSION_SECRET="test-session-secret"; await prisma.$connect(); });
beforeEach(async () => { await prisma.inboundChannelEvent.deleteMany(); await prisma.feishuConversation.deleteMany(); await prisma.auditEvent.deleteMany(); await prisma.submissionSnapshot.deleteMany(); await prisma.agentFieldProposal.deleteMany(); await prisma.validationResult.deleteMany(); await prisma.expenseItem.deleteMany(); await prisma.receipt.deleteMany(); await prisma.clarification.deleteMany(); await prisma.claimDraft.deleteMany(); await prisma.policyChunk.deleteMany(); await prisma.policyDocumentSnapshot.deleteMany(); await prisma.policySource.deleteMany(); await prisma.employee.deleteMany(); });
afterAll(async () => prisma.$disconnect());
it("restricts policy sources to allowlisted administrators and validates the explicit Feishu URL", async () => {
  await prisma.employee.create({ data:{ id:"admin", displayName:"财务", feishuUserId:"ou_finance" } });
  const token=createSessionToken("admin",process.env.SESSION_SECRET!); process.env.POLICY_ADMIN_FEISHU_OPEN_IDS="ou_finance";
  expect((await GET(new Request("http://localhost/api/admin/policy-sources"))).status).toBe(401);
  expect((await POST(new Request("http://localhost/api/admin/policy-sources",{method:"POST",headers:{cookie:`reimbursement_session=${token}`,"content-type":"application/json"},body:JSON.stringify({title:"制度",url:"https://evil.example/docx/ABCdef0123456789"})}))).status).toBe(400);
  const response=await POST(new Request("http://localhost/api/admin/policy-sources",{method:"POST",headers:{cookie:`reimbursement_session=${token}`,"content-type":"application/json"},body:JSON.stringify({title:"制度",url:"https://acme.feishu.cn/docx/ABCdef0123456789"})}));
  expect(response.status).toBe(201); await expect(response.json()).resolves.toEqual(expect.objectContaining({type:"FEISHU_DOCX",enabled:true}));
});
