import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PrismaClaimRepository } from "@/src/infrastructure/prisma/claim-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);
const claims = new PrismaClaimRepository(prisma);

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  await prisma.submissionSnapshot.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.claimDraft.deleteMany();
  await prisma.employee.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

it("rejects an update made with a stale draft version", async () => {
  const employee = await prisma.employee.create({ data: { id: "employee-a", displayName: "测试员工" } });
  const draft = await claims.create({ employeeId: employee.id, purpose: "客户拜访", status: "DRAFT" });

  const updated = await claims.updateDraft(draft.id, draft.version, { purpose: "更新后的事由" });

  await expect(claims.updateDraft(draft.id, draft.version, { purpose: "过期更新" })).rejects.toThrow(
    "version conflict",
  );
  expect(updated.version).toBe(1);
});
