import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { processAsyncJob } from "@/src/application/process-async-job";
import { runAsyncJobWorkerOnce } from "@/src/application/run-async-job-worker";
import { PrismaAsyncJobRepository } from "@/src/infrastructure/prisma/async-job-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);
const employeeId = "flow-policy-admin";

beforeAll(async () => prisma.$connect());
beforeEach(cleanup);
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

async function cleanup() {
  await prisma.reviewCase.deleteMany({ where: { policySource: { createdByEmployeeId: employeeId } } });
  await prisma.asyncJob.deleteMany({ where: { policySource: { createdByEmployeeId: employeeId } } });
  await prisma.policyDocumentSnapshot.deleteMany({ where: { source: { createdByEmployeeId: employeeId } } });
  await prisma.policySource.deleteMany({ where: { createdByEmployeeId: employeeId } });
  await prisma.employee.deleteMany({ where: { id: employeeId } });
}

it("moves an enqueued policy source sync through one durable worker poll to success", async () => {
  await prisma.employee.create({ data: { id: employeeId, displayName: "政策流程管理员", role: "ADMIN" } });
  const source = await prisma.policySource.create({ data: { type: "FEISHU_DOCX", canonicalUrl: "https://example.feishu.cn/docx/flow-policy", resourceToken: "flow-policy", title: "流程制度", createdByEmployeeId: employeeId } });
  const jobs = new PrismaAsyncJobRepository(prisma);
  const job = await jobs.enqueueJob({ kind: "POLICY_SOURCE_SYNC", policySourceId: source.id });
  await prisma.asyncJob.update({ where: { id: job.id }, data: { availableAt: new Date("2000-01-01T00:00:00.000Z") } });
  let synchronized = false;

  expect(await runAsyncJobWorkerOnce({
    jobs,
    process: (claimed) => processAsyncJob(claimed, {
      jobs,
      extractReceipt: async () => { throw new Error("must not extract a policy source"); },
      syncPolicySource: async ({ sourceId }) => { synchronized = sourceId === source.id; },
    }),
    now: () => new Date("2001-01-01T00:05:00.000Z"),
    leaseMs: 60_000,
  })).toBe(true);

  expect(synchronized).toBe(true);
  await expect(prisma.asyncJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toMatchObject({ status: "SUCCEEDED", attemptCount: 1 });
});
