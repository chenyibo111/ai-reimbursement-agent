import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { PrismaPolicyRepository } from "@/src/infrastructure/prisma/policy-repository";
import { createPrismaClient } from "@/src/infrastructure/prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://reimbursement:reimbursement@127.0.0.1:5433/reimbursement_test";
const prisma = createPrismaClient(databaseUrl);

beforeAll(async () => { await prisma.$connect(); });
beforeEach(async () => {
  await prisma.policyAuditEvent.deleteMany();
  await prisma.policyRule.deleteMany();
  await prisma.policyVersion.deleteMany();
});
afterAll(async () => prisma.$disconnect());

it("publishes an immutable policy version with its rules and an audit trail", async () => {
  const repository = new PrismaPolicyRepository(prisma);
  const draft = await repository.createDraft({
    title: "2026 差旅报销制度",
    actorId: "employee-finance",
    effectiveFrom: new Date("2026-10-01T00:00:00.000Z"),
  });

  const revised = await repository.replaceDraftRules({
    policyVersionId: draft.id,
    actorId: "employee-finance",
    expectedVersion: draft.version,
    rules: [{
      code: "TRAVEL_ITEM_CAP",
      name: "差旅单笔上限",
      type: "CATEGORY_ITEM_MAX",
      severity: "BLOCKING",
      config: { category: "交通", maxAmountCents: 100_000 },
      sortOrder: 0,
    }],
  });

  const published = await repository.publish({
    policyVersionId: revised.id,
    actorId: "employee-finance",
    expectedVersion: revised.version,
    now: new Date("2026-09-26T00:00:00.000Z"),
  });

  expect(published).toMatchObject({ id: draft.id, status: "PUBLISHED", version: 2 });
  expect(published.rules).toEqual([expect.objectContaining({ code: "TRAVEL_ITEM_CAP", type: "CATEGORY_ITEM_MAX" })]);
  await expect(repository.replaceDraftRules({ policyVersionId: published.id, actorId: "employee-finance", expectedVersion: published.version, rules: [] })).rejects.toThrow("policy version is not draft");
  await expect(repository.getCurrentPublished(new Date("2026-10-01T00:00:00.000Z"))).resolves.toMatchObject({ id: published.id, status: "PUBLISHED" });
  await expect(prisma.policyAuditEvent.findMany({ where: { policyVersionId: published.id }, orderBy: { createdAt: "asc" } })).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "POLICY_VERSION_PUBLISHED", actorId: "employee-finance" })]),
  );
});
